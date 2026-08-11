/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";

/**
 * Which of the two capture devices a default applies to.
 */
export type CallDevice = "audio" | "video";

/**
 * The shape of the `io.element.device_mute` widget action's data, in both
 * directions. An absent field means "leave this one alone".
 */
export type DeviceMuteState = {
    audio_enabled?: boolean;
    video_enabled?: boolean;
};

const SETTING_NAMES = {
    audio: "audioInputMuted",
    video: "videoInputMuted",
} as const;

/**
 * Whether calls are joined with the given device live, as chosen with the left
 * panel's toggles. The choice is per-device (not per-account), which matches
 * the fact that the microphone and camera themselves are.
 */
export function isCallDeviceEnabledByDefault(device: CallDevice): boolean {
    return !SettingsStore.getValue(SETTING_NAMES[device]);
}

/**
 * Choose whether calls are joined with the given device live. This only affects
 * calls joined from now on; a call that is already running keeps its own state,
 * which the user controls from the call itself.
 */
export async function setCallDeviceEnabledByDefault(device: CallDevice, enabled: boolean): Promise<void> {
    await SettingsStore.setValue(SETTING_NAMES[device], null, SettingLevel.DEVICE, !enabled);
}

/**
 * The mic and camera state a newly joined call should be put into.
 *
 * @param voiceOnly Whether the user asked for a voice call. The camera stays off
 *     for those no matter what the default says - the user just said they did not
 *     want video.
 */
export function getDefaultDeviceMuteState(voiceOnly = false): Required<DeviceMuteState> {
    return {
        audio_enabled: isCallDeviceEnabledByDefault("audio"),
        video_enabled: !voiceOnly && isCallDeviceEnabledByDefault("video"),
    };
}
