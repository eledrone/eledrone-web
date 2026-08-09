/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { webFrameMain, type WebContents } from "electron";

const execFileAsync = promisify(execFile);

/**
 * Linux screen-share audio support.
 *
 * Electron can only supply system audio to `getDisplayMedia` via `audio: "loopback"`, which upstream
 * documents as Windows-only. Linux therefore has no main-process route to desktop audio at all, which
 * is why element-call#3657 has been open since 2022 and why the upstream Linux attempt
 * (element-web#33044) reached for the native venmic module.
 *
 * We avoid a native dependency entirely and drive PulseAudio/PipeWire through `pactl`:
 *
 *   1. a null sink "ElementShare" that carries the audio to be shared
 *   2. a *remapped source* of its monitor - Chromium refuses to enumerate anything flagged
 *      `device.class = "monitor"`, so a plain monitor is invisible to getUserMedia, while a remap
 *      is not so flagged and shows up like an ordinary microphone
 *   3. a loopback back to the real output, so the user still hears what they are sharing
 *
 * Every application stream except Element's own is then moved into the null sink for the duration of
 * the share. Excluding Element is what stops remote participants hearing themselves: capturing the
 * default sink's monitor instead would be far simpler, but it necessarily includes the call's own
 * playback.
 *
 * Element Call runs as a same-origin iframe (`vector://vector/widgets/element-call/`), so the
 * getDisplayMedia wrapper below is injected straight into that frame's main world.
 */

/** Sink carrying the audio to be shared. Also the *description* of the capture source. */
const SINK_NAME = "ElementShare";
/** Name of the remapped source the renderer captures. */
const SOURCE_NAME = "ElementShareMic";
/** Marker the injected code logs when a share ends, so we can tear the routing down again. */
const SHARE_ENDED_MARKER = "element-screenshare-audio:share-ended";

/** Streams we moved, so they can be put back exactly where they were. */
interface MovedStream {
    index: string;
    originalSink: string;
}

let movedStreams: MovedStream[] = [];
let loadedModules: string[] = [];
let teardownTimer: NodeJS.Timeout | undefined;

async function pactl(args: string[]): Promise<string> {
    // LC_ALL=C is required, not cosmetic: pactl localises its output ("Sink Input #" becomes
    // "Вхід приймача #" and so on), and everything below parses it.
    const { stdout } = await execFileAsync("pactl", args, {
        timeout: 5000,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return stdout;
}

async function pactlAvailable(): Promise<boolean> {
    try {
        await pactl(["info"]);
        return true;
    } catch {
        return false;
    }
}

async function getDefaultSink(): Promise<string> {
    try {
        const name = (await pactl(["get-default-sink"])).trim();
        if (name) return name;
    } catch {
        // `get-default-sink` only exists from PulseAudio 15 / recent pipewire-pulse.
    }
    const info = await pactl(["info"]);
    return /^Default Sink:\s*(.+)$/m.exec(info)?.[1].trim() ?? "";
}

async function sinkExists(name: string): Promise<boolean> {
    const out = await pactl(["list", "short", "sinks"]);
    return out.split("\n").some((line) => line.split(/\s+/)[1] === name);
}

/**
 * Finds modules belonging to us. Used both to tear down after a share and to clear anything left
 * behind by a previous run that exited uncleanly - otherwise stale modules would silently capture
 * nothing, or worse, leave the user's audio routed into a sink they cannot hear.
 */
async function findOurModules(): Promise<string[]> {
    const out = await pactl(["list", "short", "modules"]);
    const ids: string[] = [];
    for (const line of out.split("\n")) {
        const parts = line.split(/\s+/);
        const [id, name] = parts;
        const args = parts.slice(2).join(" ");
        if (!id || !name) continue;
        if (name === "module-null-sink" && args.includes(`sink_name=${SINK_NAME}`)) ids.push(id);
        else if (name === "module-remap-source" && args.includes(`source_name=${SOURCE_NAME}`)) ids.push(id);
        else if (name === "module-loopback" && args.includes(`source=${SINK_NAME}.monitor`)) ids.push(id);
    }
    return ids;
}

/** One entry per playing stream. `application` is empty for internal streams such as our loopback. */
function parseSinkInputs(output: string): Array<{ index: string; sink: string; application: string }> {
    const streams: Array<{ index: string; sink: string; application: string }> = [];
    let current: { index: string; sink: string; application: string } | undefined;

    for (const rawLine of output.split("\n")) {
        const line = rawLine.trim();
        const header = /^Sink Input #(\d+)/.exec(line);
        if (header) {
            if (current) streams.push(current);
            current = { index: header[1], sink: "", application: "" };
            continue;
        }
        if (!current) continue;

        const sink = /^Sink:\s+(\d+)/.exec(line);
        if (sink) current.sink = sink[1];

        const app = /^application\.name = "(.*)"$/.exec(line);
        if (app) current.application = app[1];
    }
    if (current) streams.push(current);
    return streams;
}

/**
 * Element's own playback must never be shared - that is what makes remote participants hear
 * themselves. Streams with no owning application are internal (our loopback's own playback stream);
 * moving one would make it feed itself and destroy the monitoring path.
 */
function isMovable(stream: { application: string }): boolean {
    if (!stream.application) return false;
    return !/element/i.test(stream.application);
}

async function ensureModules(): Promise<void> {
    if (await sinkExists(SINK_NAME)) return;

    const realSink = await getDefaultSink();
    if (!realSink || realSink === SINK_NAME) {
        throw new Error(`refusing to set up: default sink is "${realSink}"`);
    }

    const nullSink = await pactl([
        "load-module",
        "module-null-sink",
        `sink_name=${SINK_NAME}`,
        `sink_properties=device.description=${SINK_NAME}`,
    ]);
    loadedModules.push(nullSink.trim());

    // A remapped source is not flagged as a monitor, so Chromium enumerates it.
    const remap = await pactl([
        "load-module",
        "module-remap-source",
        `master=${SINK_NAME}.monitor`,
        `source_name=${SOURCE_NAME}`,
        `source_properties=device.description=${SINK_NAME}`,
    ]);
    loadedModules.push(remap.trim());

    // Without this the user shares the audio but cannot hear it themselves. Non-fatal: sharing
    // still works, so a failure here must not cost the user the whole feature.
    try {
        const loopback = await pactl([
            "load-module",
            "module-loopback",
            `source=${SINK_NAME}.monitor`,
            `sink=${realSink}`,
            "latency_msec=50",
        ]);
        loadedModules.push(loopback.trim());
    } catch (err) {
        console.error("Screen-share audio: local monitoring unavailable (you may not hear it):", err);
    }
}

async function moveApplicationsIntoShare(): Promise<void> {
    const streams = parseSinkInputs(await pactl(["list", "sink-inputs"]));
    for (const stream of streams) {
        if (!isMovable(stream)) continue;
        try {
            await pactl(["move-sink-input", stream.index, SINK_NAME]);
            movedStreams.push({ index: stream.index, originalSink: stream.sink });
        } catch (err) {
            console.error(`Failed to route "${stream.application}" into the screen share:`, err);
        }
    }
}

/**
 * Restores every stream we moved and unloads our modules. Safe to call when nothing is set up, and
 * safe to call twice - which matters because it runs both when a share ends and when the app quits.
 */
export async function teardownScreenshareAudio(): Promise<void> {
    if (process.platform !== "linux") return;
    if (teardownTimer) {
        clearTimeout(teardownTimer);
        teardownTimer = undefined;
    }
    if (!(await pactlAvailable())) return;

    let fallbackSink = "";
    try {
        fallbackSink = await getDefaultSink();
    } catch {
        /* handled below */
    }

    for (const moved of movedStreams) {
        const target = moved.originalSink || fallbackSink;
        if (!target) continue;
        try {
            await pactl(["move-sink-input", moved.index, target]);
        } catch {
            // The stream is simply gone - the application closed during the share.
        }
    }
    movedStreams = [];

    // Unload in reverse: the loopback and remap depend on the sink.
    const ids = loadedModules.length ? loadedModules : await findOurModules();
    for (const id of [...ids].reverse()) {
        try {
            await pactl(["unload-module", id]);
        } catch {
            /* already gone */
        }
    }
    loadedModules = [];
}

/**
 * Prepares desktop audio capture for a screen share. Called before the display-media callback is
 * invoked, so the capture source exists by the time the page's getDisplayMedia resolves.
 *
 * Failures are logged and swallowed: the share then proceeds with video only, exactly as it did
 * before this feature existed.
 */
export async function prepareScreenshareAudio(): Promise<void> {
    if (process.platform !== "linux") return;

    if (!(await pactlAvailable())) {
        console.warn("Screen-share audio: pactl unavailable, sharing video only");
        return;
    }

    try {
        await teardownScreenshareAudio(); // clear anything a previous share left behind
        await ensureModules();
        await moveApplicationsIntoShare();
    } catch (err) {
        console.error("Screen-share audio: setup failed, sharing video only:", err);
        await teardownScreenshareAudio().catch(() => {});
    }
}

/**
 * Injected verbatim into each subframe. A string rather than a module because it is evaluated in the
 * page's world, where none of our build output exists.
 *
 * Every step degrades to "return the stream untouched", so a failure here can never break screen
 * sharing itself - the user just gets video only, exactly as before this patch.
 */
const PATCH_SOURCE = `
(() => {
    const FLAG = "__elementScreenshareAudioPatched";
    if (window[FLAG]) return;
    const md = navigator.mediaDevices;
    if (!md || typeof md.getDisplayMedia !== "function") return;
    window[FLAG] = true;

    const SOURCE_LABEL = ${JSON.stringify(SINK_NAME)};
    const ENDED_MARKER = ${JSON.stringify(SHARE_ENDED_MARKER)};
    const log = (...args) => console.log("[element-screenshare-audio]", ...args);
    const original = md.getDisplayMedia.bind(md);

    // The capture source is created by the main process moments earlier, and Chromium's device list
    // is refreshed asynchronously - so poll briefly rather than giving up on the first miss.
    const findSource = async () => {
        for (let attempt = 0; attempt < 10; attempt++) {
            const devices = await md.enumerateDevices();
            const match = devices.find(
                (d) => d.kind === "audioinput" && d.label.includes(SOURCE_LABEL),
            );
            if (match) return match;
            await new Promise((r) => setTimeout(r, 200));
        }
        return undefined;
    };

    md.getDisplayMedia = async function (constraints) {
        const stream = await original(constraints);
        try {
            if (!constraints || !constraints.audio) return stream;
            // Something already provided audio (Windows loopback, or a browser that supports it).
            if (stream.getAudioTracks().length > 0) return stream;

            const source = await findSource();
            if (!source) {
                log("no desktop audio source found; sharing video only");
                return stream;
            }

            // These three MUST be off: they are voice-tuned and would mangle music and game audio.
            const audioStream = await md.getUserMedia({
                audio: {
                    deviceId: { exact: source.deviceId },
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
            const audioTrack = audioStream.getAudioTracks()[0];
            if (!audioTrack) return stream;

            stream.addTrack(audioTrack);
            log("attached desktop audio from", source.label);

            // Tell the main process to undo the routing once the share stops. console is used
            // deliberately: this code runs in the page's world, with no IPC bridge available.
            const onEnded = () => {
                audioTrack.stop();
                log(ENDED_MARKER);
            };
            stream.getVideoTracks()[0]?.addEventListener("ended", onEnded, { once: true });
        } catch (err) {
            console.error("[element-screenshare-audio] failed to attach desktop audio", err);
        }
        return stream;
    };
})();
`;

/**
 * Installs the getDisplayMedia wrapper into every subframe, and watches for the marker the wrapper
 * logs when a share ends.
 * No-op off Linux, where the main-process loopback path is used instead.
 */
export function setupScreenshareAudio(webContents: WebContents): void {
    if (process.platform !== "linux") return;

    webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
        // The main frame never calls getDisplayMedia; Element Call does, from its widget iframe.
        if (isMainFrame) return;
        try {
            const frame = webFrameMain.fromId(frameProcessId, frameRoutingId);
            void frame?.executeJavaScript(PATCH_SOURCE).catch((err) => {
                console.error("Failed to inject screenshare audio patch:", err);
            });
        } catch (err) {
            console.error("Failed to resolve frame for screenshare audio patch:", err);
        }
    });

    // Electron has moved this event's shape across versions; accept both.
    webContents.on("console-message", (...args: any[]) => {
        const message: string = typeof args[1] === "string" ? args[1] : (args[0]?.message ?? "");
        if (!message.includes(SHARE_ENDED_MARKER)) return;
        // Debounced: a share ending fires once, but a reconnect can re-emit it.
        if (teardownTimer) clearTimeout(teardownTimer);
        teardownTimer = setTimeout(() => {
            void teardownScreenshareAudio().catch((err) => {
                console.error("Screen-share audio: teardown failed:", err);
            });
        }, 500);
    });
}
