/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import { describe, expect, it, beforeEach } from "vitest";

import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import {
    getDefaultDeviceMuteState,
    isCallDeviceEnabledByDefault,
    setCallDeviceEnabledByDefault,
} from "./call-device-defaults";

describe("call device defaults", () => {
    beforeEach(async () => {
        await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, false);
        await SettingsStore.setValue("videoInputMuted", null, SettingLevel.DEVICE, false);
    });

    it("treats the microphone as on until told otherwise", () => {
        expect(isCallDeviceEnabledByDefault("audio")).toBe(true);
        expect(getDefaultDeviceMuteState()).toEqual({ audio_enabled: true, video_enabled: false });
    });

    it("stores each device's choice separately", async () => {
        await setCallDeviceEnabledByDefault("audio", false);

        expect(isCallDeviceEnabledByDefault("audio")).toBe(false);
        expect(isCallDeviceEnabledByDefault("video")).toBe(true);
        expect(getDefaultDeviceMuteState()).toEqual({ audio_enabled: false, video_enabled: false });
    });

    it("keeps the choice on this device, not on the account", async () => {
        await setCallDeviceEnabledByDefault("video", false);

        // The microphone and camera are per-device, so the choice of whether to
        // join with them has to be too - it must not follow the user elsewhere.
        expect(SettingsStore.getValueAt(SettingLevel.DEVICE, "videoInputMuted", null, true, true)).toBe(true);
    });

    it("never joins with the camera on, whatever the stored default says", async () => {
        // Arriving in a call already on camera is startling in a way that
        // arriving unmuted is not; the panel has a button for turning it on.
        await setCallDeviceEnabledByDefault("video", true);

        expect(isCallDeviceEnabledByDefault("video")).toBe(true);
        expect(getDefaultDeviceMuteState().video_enabled).toBe(false);
    });
});
