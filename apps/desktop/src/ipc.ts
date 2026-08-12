/*
Copyright 2022-2025 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, autoUpdater, desktopCapturer, ipcMain, powerSaveBlocker, TouchBar, nativeImage } from "electron";

import IpcMainEvent = Electron.IpcMainEvent;
import { randomArray } from "./utils.js";
import {
    getDisplayMediaCallback,
    isDisplayMediaAudioRequested,
    setDisplayMediaCallback,
} from "./displayMediaCallback.js";
import Store, { clearDataAndRelaunch } from "./store.js";
import { getConfig } from "./config.js";
import { deleteTheme, getThemesDirectory, listThemes, openThemesDirectory, writeTheme } from "./themes.js";

let focusHandlerAttached = false;
ipcMain.on("loudNotification", function (): void {
    if (process.platform === "win32" || process.platform === "linux") {
        if (global.mainWindow && !global.mainWindow.isFocused() && !focusHandlerAttached) {
            global.mainWindow.flashFrame(true);
            global.mainWindow.once("focus", () => {
                global.mainWindow?.flashFrame(false);
                focusHandlerAttached = false;
            });
            focusHandlerAttached = true;
        }
    }
});

let powerSaveBlockerId: number | null = null;
ipcMain.on("app_onAction", function (_ev: IpcMainEvent, payload) {
    switch (payload.action) {
        case "call_state": {
            if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                if (payload.state === "ended") {
                    powerSaveBlocker.stop(powerSaveBlockerId);
                    powerSaveBlockerId = null;
                }
            } else {
                if (powerSaveBlockerId === null && payload.state === "connected") {
                    powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");
                }
            }
            break;
        }
    }
});

ipcMain.on("ipcCall", async function (_ev: IpcMainEvent, payload) {
    const store = Store.instance;
    if (!global.mainWindow || !store) return;

    const args = payload.args || [];
    let ret: any;

    switch (payload.name) {
        case "getUpdateFeedUrl":
            ret = autoUpdater.getFeedURL();
            break;
        case "setLanguage":
            global.appLocalization.setAppLocale(args[0]);
            break;
        case "getAppVersion":
            ret = app.getVersion();
            break;
        case "focusWindow":
            if (global.mainWindow.isMinimized()) {
                global.mainWindow.restore();
            } else {
                global.mainWindow.show();
                global.mainWindow.focus();
            }
            break;

        case "navigateBack":
            if (global.mainWindow.webContents.canGoBack()) {
                global.mainWindow.webContents.goBack();
            }
            break;
        case "navigateForward":
            if (global.mainWindow.webContents.canGoForward()) {
                global.mainWindow.webContents.goForward();
            }
            break;
        case "setSpellCheckEnabled":
            if (typeof args[0] !== "boolean") return;

            global.mainWindow.webContents.session.setSpellCheckerEnabled(args[0]);
            store.set("spellCheckerEnabled", args[0]);
            break;

        case "getSpellCheckEnabled":
            ret = store.get("spellCheckerEnabled");
            break;

        case "setSpellCheckLanguages":
            try {
                global.mainWindow.webContents.session.setSpellCheckerLanguages(args[0]);
            } catch (er) {
                console.log("There were problems setting the spellcheck languages", er);
            }
            break;

        case "getSpellCheckLanguages":
            ret = global.mainWindow.webContents.session.getSpellCheckerLanguages();
            break;
        case "getAvailableSpellCheckLanguages":
            ret = global.mainWindow.webContents.session.availableSpellCheckerLanguages;
            break;

        case "getPickleKey":
            try {
                ret = await store.getSecret(`${args[0]}|${args[1]}`);
            } catch {
                // if an error is thrown (e.g. we can't initialise safeStorage),
                // then return null, which means the default pickle key will be used
                ret = null;
            }
            break;

        case "createPickleKey":
            try {
                const pickleKey = await randomArray(32);
                await store.setSecret(`${args[0]}|${args[1]}`, pickleKey);
                ret = pickleKey;
            } catch (e) {
                console.error("Failed to create pickle key", e);
                ret = null;
            }
            break;

        case "destroyPickleKey":
            try {
                await store.deleteSecret(`${args[0]}|${args[1]}`);
            } catch (e) {
                console.error("Failed to destroy pickle key", e);
            }
            break;
        case "getDesktopCapturerSources":
            ret = (await desktopCapturer.getSources(args[0])).map((source) => ({
                id: source.id,
                name: source.name,
                thumbnailURL: source.thumbnail.toDataURL(),
            }));
            break;
        case "callDisplayMediaCallback":
            getDisplayMediaCallback()?.({
                video: args[0],
                // "loopback" captures the system audio mix. Electron only supports it on Windows, and
                // passing it elsewhere would break screen sharing outright - Linux gets its audio from
                // the monitor-source path in screenshareAudio.ts instead.
                ...(process.platform === "win32" && isDisplayMediaAudioRequested()
                    ? { audio: "loopback" as const }
                    : {}),
            });
            setDisplayMediaCallback(null);
            ret = null;
            break;

        // The CSS themes the user has dropped in their themes folder. The
        // renderer holds no copy of them - the folder is the only source - so
        // it asks for the lot each time and re-applies what it is given.
        //
        // These touch the file system on names that came from the renderer, so
        // unlike the calls above they can genuinely fail. An unhandled
        // rejection here would leave the renderer's promise pending forever,
        // so failures are sent back as errors for it to show.
        case "getThemes":
        case "writeTheme":
        case "deleteTheme":
        case "openThemesDirectory":
            try {
                switch (payload.name) {
                    case "getThemes":
                        ret = { directory: getThemesDirectory(), themes: await listThemes() };
                        break;
                    case "writeTheme":
                        await writeTheme(args[0], args[1]);
                        break;
                    case "deleteTheme":
                        await deleteTheme(args[0]);
                        break;
                    case "openThemesDirectory":
                        await openThemesDirectory();
                        break;
                }
            } catch (e) {
                console.error(`Theme IPC call ${payload.name} failed`, e);
                global.mainWindow.webContents.send("ipcReply", {
                    id: payload.id,
                    error: { message: e instanceof Error ? e.message : String(e) },
                });
                return;
            }
            break;

        case "clearStorage":
            await clearDataAndRelaunch(global.mainWindow.webContents.session);
            return; // the app is about to stop, we don't need to reply to the IPC

        case "breadcrumbs": {
            if (process.platform === "darwin") {
                const { TouchBarPopover, TouchBarButton } = TouchBar;

                const recentsBar = new TouchBar({
                    items: args[0].map((r: { roomId: string; avatarUrl: string | null; initial: string }) => {
                        const defaultColors = ["#0DBD8B", "#368bd6", "#ac3ba8"];
                        let total = 0;
                        for (let i = 0; i < r.roomId.length; ++i) {
                            total += r.roomId.charCodeAt(i);
                        }

                        const button = new TouchBarButton({
                            label: r.initial,
                            backgroundColor: defaultColors[total % defaultColors.length],
                            click: (): void => {
                                void global.mainWindow?.loadURL(`vector://vector/webapp/#/room/${r.roomId}`);
                            },
                        });
                        if (r.avatarUrl) {
                            void fetch(r.avatarUrl)
                                .then((resp) => {
                                    if (!resp.ok) return;
                                    return resp.arrayBuffer();
                                })
                                .then((arrayBuffer) => {
                                    if (!arrayBuffer) return;
                                    const buffer = Buffer.from(arrayBuffer);
                                    button.icon = nativeImage.createFromBuffer(buffer);
                                    button.label = "";
                                    button.backgroundColor = "";
                                });
                        }
                        return button;
                    }),
                });

                const touchBar = new TouchBar({
                    items: [
                        new TouchBarPopover({
                            label: "Recents",
                            showCloseButton: true,
                            items: recentsBar,
                        }),
                    ],
                });
                global.mainWindow.setTouchBar(touchBar);
            }
            break;
        }

        default:
            global.mainWindow.webContents.send("ipcReply", {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    global.mainWindow?.webContents.send("ipcReply", {
        id: payload.id,
        reply: ret,
    });
});

ipcMain.handle("getConfig", getConfig);

const initialisePromiseWithResolvers = Promise.withResolvers<void>();
export const initialisePromise = initialisePromiseWithResolvers.promise;

ipcMain.once("initialise", () => {
    initialisePromiseWithResolvers.resolve();
});
