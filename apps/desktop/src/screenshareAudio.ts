/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { webFrameMain, type WebContents } from "electron";

/**
 * Linux screen-share audio support.
 *
 * Electron can only supply system audio to `getDisplayMedia` via `audio: "loopback"`, which upstream
 * documents as Windows-only. Linux therefore has no main-process route to desktop audio at all, which
 * is why element-call#3657 has been open since 2022 and why the upstream Linux attempt
 * (element-web#33044) reached for the native venmic module.
 *
 * We avoid a native dependency entirely: PulseAudio/PipeWire expose every sink`s *monitor* as a normal
 * capture device, which Chromium enumerates like any other microphone. So once the screen-share stream
 * exists we simply capture the monitor and staple that track onto it.
 *
 * Element Call runs as a same-origin iframe (`vector://vector/widgets/element-call/`), so the wrapper is
 * installed straight into that frame`s main world. The wrapper only has to exist before the user clicks
 * "share screen" — far later than frame load — so injecting on frame load has no race.
 */

/** Sink name looked for first; created by the element-share-audio.sh helper. */
const PREFERRED_SINK = "ElementShare";

/**
 * Injected verbatim into each subframe. This is a string rather than a module because it is evaluated
 * in the page`s world, where none of our build output exists.
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

    const log = (...args) => console.log("[element-screenshare-audio]", ...args);
    const original = md.getDisplayMedia.bind(md);

    md.getDisplayMedia = async function (constraints) {
        const stream = await original(constraints);
        try {
            // Audio was never asked for - nothing to do.
            if (!constraints || !constraints.audio) return stream;
            // Something already provided audio (Windows loopback, or a browser that supports it).
            if (stream.getAudioTracks().length > 0) return stream;

            const devices = await md.enumerateDevices();
            const inputs = devices.filter((d) => d.kind === "audioinput");
            // Labels are empty until microphone permission has been granted; without them we cannot
            // tell a monitor from a real microphone, and capturing the microphone here would be wrong.
            const monitor =
                inputs.find((d) => d.label.includes(${JSON.stringify(PREFERRED_SINK)})) ??
                inputs.find((d) => /monitor/i.test(d.label));
            if (!monitor) {
                log("no monitor source found; sharing video only");
                return stream;
            }

            // These three MUST be off: they are voice-tuned and would mangle music and game audio.
            const audioStream = await md.getUserMedia({
                audio: {
                    deviceId: { exact: monitor.deviceId },
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
            });
            const audioTrack = audioStream.getAudioTracks()[0];
            if (!audioTrack) return stream;

            stream.addTrack(audioTrack);
            // Stop the capture when the share ends, otherwise the monitor stays open forever.
            stream.getVideoTracks()[0]?.addEventListener("ended", () => audioTrack.stop());
            log("attached desktop audio from", monitor.label);
        } catch (err) {
            console.error("[element-screenshare-audio] failed to attach desktop audio", err);
        }
        return stream;
    };
})();
`;

/**
 * Installs the getDisplayMedia wrapper into every subframe of the given WebContents.
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
}
