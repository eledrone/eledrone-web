/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ThemeStore } from "./ThemeStore";
import { type CssThemeListing, type CssThemeSource, StoredCssThemeSource } from "./CssThemeSource";
import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import PlatformPeg from "../PlatformPeg";
import type BasePlatform from "../BasePlatform";

const store = ThemeStore.instance;

const appliedThemeNames = (): string[] =>
    [...document.querySelectorAll("style[data-css-theme]")].map((style) => style.getAttribute("data-css-theme")!);

const appliedThemeCss = (): string =>
    [...document.querySelectorAll("style[data-css-theme]")].map((style) => style.textContent).join("\n");

const appliedPalette = (): string | null => document.querySelector("style[data-css-palette]")?.textContent ?? null;

const frameThemeCss = (frame: HTMLIFrameElement): string =>
    [...(frame.contentDocument?.querySelectorAll("style[data-css-theme]") ?? [])]
        .map((style) => style.textContent)
        .join("\n");

const framePalette = (frame: HTMLIFrameElement): string | null =>
    frame.contentDocument?.querySelector("style[data-css-palette]")?.textContent ?? null;

/** A widget, as far as this store is concerned: an iframe it can reach into. */
async function addFrame(): Promise<HTMLIFrameElement> {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    await vi.waitFor(() => expect(frame.contentDocument?.head).toBeTruthy());
    return frame;
}

/** A source whose contents the test drives directly, standing in for a themes folder. */
class FakeSource implements CssThemeSource {
    public readonly canReveal = true;
    public revealed = 0;
    public themes = new Map<string, string>();
    private listeners = new Set<() => void>();

    public async list(): Promise<CssThemeListing> {
        return {
            directory: "/home/someone/.config/eledrone/themes",
            themes: [...this.themes].map(([fileName, css]) => ({ fileName, css })),
        };
    }

    public async write(fileName: string, css: string): Promise<void> {
        this.themes.set(fileName, css);
    }

    public async remove(fileName: string): Promise<void> {
        this.themes.delete(fileName);
    }

    public async reveal(): Promise<void> {
        this.revealed++;
    }

    public watch(onChange: () => void): () => void {
        this.listeners.add(onChange);
        return () => this.listeners.delete(onChange);
    }

    /** Pretends somebody saved a file in the folder. */
    public changed(): void {
        for (const listener of this.listeners) listener();
    }
}

let source: FakeSource;

/** Starts the store against {@link source}, as it would be on desktop. */
async function start(): Promise<void> {
    vi.spyOn(PlatformPeg, "get").mockReturnValue({
        getCssThemeSource: () => source,
    } as unknown as BasePlatform);
    await store.start();
}

describe("ThemeStore", () => {
    beforeEach(async () => {
        source = new FakeSource();
        window.localStorage.clear();
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, []);
        await SettingsStore.setValue("accentColour", null, SettingLevel.DEVICE, null);
        await SettingsStore.setValue("surfaceColour", null, SettingLevel.DEVICE, null);
    });

    afterEach(() => {
        store.stop();
        vi.restoreAllMocks();
        for (const style of document.querySelectorAll("style[data-css-theme], style[data-css-palette]")) {
            style.remove();
        }
        for (const frame of document.querySelectorAll("iframe")) frame.remove();
    });

    it("applies the stylesheets that are switched on, and no others", async () => {
        source.themes.set("pink.css", ":root { --thing: pink; }");
        source.themes.set("blue.css", ":root { --thing: blue; }");
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, ["pink.css"]);

        await start();

        expect(store.themes.map((theme) => theme.fileName)).toEqual(["pink.css", "blue.css"]);
        expect(appliedThemeNames()).toEqual(["pink.css"]);
        expect(appliedThemeCss()).toContain("--thing: pink");
    });

    it("applies several in the order they were switched on, so the last one wins", async () => {
        source.themes.set("a.css", "a {}");
        source.themes.set("b.css", "b {}");
        await start();

        await store.setEnabled("b.css", true);
        await store.setEnabled("a.css", true);

        expect(appliedThemeNames()).toEqual(["b.css", "a.css"]);
    });

    it("colours the app from the switcher when no stylesheet is applied", async () => {
        await SettingsStore.setValue("accentColour", null, SettingLevel.DEVICE, "#ff4fa3");
        await start();

        expect(store.isCssThemeApplied).toBe(false);
        expect(appliedPalette()).toContain("--cpd-color-green-900:");
    });

    it("keeps the switcher's colours underneath an applied stylesheet", async () => {
        // The two are not exclusive: the theme is unlayered and the palette is
        // not, so the cascade gives each token to whichever set it, and the
        // picked colours still reach everything the theme says nothing about.
        await SettingsStore.setValue("accentColour", null, SettingLevel.DEVICE, "#ff4fa3");
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await start();

        await store.setEnabled("pink.css", true);

        expect(store.isCssThemeApplied).toBe(true);
        expect(appliedThemeCss()).toContain("--thing: pink");
        expect(appliedPalette()).toContain("--cpd-color-green-900:");
    });

    it("treats a stylesheet that has gone missing as no stylesheet at all", async () => {
        // The file was deleted from the folder, but the setting still names it
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, ["gone.css"]);
        await SettingsStore.setValue("accentColour", null, SettingLevel.DEVICE, "#ff4fa3");

        await start();

        expect(store.isCssThemeApplied).toBe(false);
        expect(appliedPalette()).toContain("--cpd-color-green-900:");
    });

    it("picks up a stylesheet saved in the folder while the app is running", async () => {
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await start();
        await store.setEnabled("pink.css", true);

        source.themes.set("pink.css", ":root { --thing: hotpink; }");
        source.changed();
        // The source callback is not awaited by the watcher, so wait for the reload
        await vi.waitFor(() => expect(appliedThemeCss()).toContain("hotpink"));

        expect(appliedThemeNames()).toEqual(["pink.css"]);
    });

    it("imports a file into the source and switches it on", async () => {
        await start();

        await store.importFiles([new File([":root { --thing: pink; }"], "Pink Charcoal.css")]);

        // The name is made safe for a file system on the way in
        expect([...source.themes.keys()]).toEqual(["Pink_Charcoal.css"]);
        expect(store.enabledThemeNames).toEqual(["Pink_Charcoal.css"]);
        expect(appliedThemeNames()).toEqual(["Pink_Charcoal.css"]);
    });

    it("gives an imported file a .css extension if it arrives without one", async () => {
        await start();

        await store.importFiles([new File(["a {}"], "theme")]);

        expect([...source.themes.keys()]).toEqual(["theme.css"]);
    });

    it("deleting a theme removes it and forgets that it was on", async () => {
        source.themes.set("pink.css", "a {}");
        await start();
        await store.setEnabled("pink.css", true);

        await store.remove("pink.css");

        expect(source.themes.size).toBe(0);
        expect(store.enabledThemeNames).toEqual([]);
        expect(appliedThemeNames()).toEqual([]);
    });

    it("treats a setting of the wrong shape as nothing switched on", async () => {
        // Device settings are local JSON that an older version, a hand edit or
        // a half-finished write can leave in any shape. A theme list is not
        // worth throwing the settings dialog over.
        vi.spyOn(SettingsStore, "getValue").mockImplementation((setting) =>
            setting === "cssThemes" ? (true as never) : (null as never),
        );

        await start();

        expect(store.enabledThemeNames).toEqual([]);
        expect(store.isCssThemeApplied).toBe(false);
    });

    it("keeps what is applied when the source cannot be read", async () => {
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await start();
        await store.setEnabled("pink.css", true);

        vi.spyOn(source, "list").mockRejectedValue(new Error("the folder went away"));
        await store.refresh();

        expect(appliedThemeNames()).toEqual(["pink.css"]);
    });

    it("writes into a widget that was already there", async () => {
        // The call view is Element Call in an iframe, and styles do not cross
        // that boundary on their own.
        const frame = await addFrame();
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, ["pink.css"]);

        await start();

        expect(frameThemeCss(frame)).toContain("--thing: pink");
    });

    it("writes into a widget that turns up later", async () => {
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, ["pink.css"]);
        await start();

        const frame = await addFrame();

        await vi.waitFor(() => expect(frameThemeCss(frame)).toContain("--thing: pink"));
    });

    it("writes into a widget again once it has reloaded", async () => {
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, ["pink.css"]);
        await start();
        const frame = await addFrame();
        await vi.waitFor(() => expect(frameThemeCss(frame)).toContain("--thing: pink"));

        // A reload replaces the document, and with it everything written into it
        for (const style of frame.contentDocument!.querySelectorAll("style")) style.remove();
        frame.dispatchEvent(new Event("load"));

        expect(frameThemeCss(frame)).toContain("--thing: pink");
    });

    it("gives a widget the switcher's colours when no stylesheet is applied", async () => {
        await SettingsStore.setValue("accentColour", null, SettingLevel.DEVICE, "#ff4fa3");
        const frame = await addFrame();

        await start();

        expect(framePalette(frame)).toContain("--cpd-color-green-900:");
    });

    it("leaves a widget it cannot reach alone", async () => {
        // Element Call pointed somewhere else by Developer.elementCallUrl, or
        // any third-party widget: another origin, so there is nothing to do.
        const frame = document.createElement("iframe");
        Object.defineProperty(frame, "contentDocument", {
            get() {
                throw new Error("Blocked a frame with origin from accessing a cross-origin frame");
            },
        });
        document.body.appendChild(frame);
        source.themes.set("pink.css", ":root { --thing: pink; }");
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, ["pink.css"]);

        await start();

        expect(appliedThemeCss()).toContain("--thing: pink");
    });

    it("keeps themes in browser storage when the platform has no folder", async () => {
        // What BasePlatform answers, and therefore what the web app gets
        vi.spyOn(PlatformPeg, "get").mockReturnValue({
            getCssThemeSource: () => new StoredCssThemeSource(),
        } as unknown as BasePlatform);
        await store.start();

        await store.importFiles([new File([":root { --thing: pink; }"], "pink.css")]);

        expect(store.canRevealDirectory).toBe(false);
        expect(store.themesDirectory).toBeNull();
        expect(appliedThemeNames()).toEqual(["pink.css"]);
        // Kept where a reload will find it again
        expect(window.localStorage.getItem("mx_css_themes")).toContain("pink.css");
    });
});
