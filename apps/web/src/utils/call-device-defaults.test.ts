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

    it("treats both devices as on until told otherwise", () => {
        expect(isCallDeviceEnabledByDefault("audio")).toBe(true);
        expect(isCallDeviceEnabledByDefault("video")).toBe(true);
        expect(getDefaultDeviceMuteState()).toEqual({ audio_enabled: true, video_enabled: true });
    });

    it("stores each device's choice separately", async () => {
        await setCallDeviceEnabledByDefault("audio", false);

        expect(isCallDeviceEnabledByDefault("audio")).toBe(false);
        expect(isCallDeviceEnabledByDefault("video")).toBe(true);
        expect(getDefaultDeviceMuteState()).toEqual({ audio_enabled: false, video_enabled: true });
    });

    it("keeps the choice on this device, not on the account", async () => {
        await setCallDeviceEnabledByDefault("video", false);

        // The microphone and camera are per-device, so the choice of whether to
        // join with them has to be too - it must not follow the user elsewhere.
        expect(SettingsStore.getValueAt(SettingLevel.DEVICE, "videoInputMuted", null, true, true)).toBe(true);
    });

    it("leaves the camera off for a voice call even when it is on by default", () => {
        expect(getDefaultDeviceMuteState(true)).toEqual({ audio_enabled: true, video_enabled: false });
    });
});
