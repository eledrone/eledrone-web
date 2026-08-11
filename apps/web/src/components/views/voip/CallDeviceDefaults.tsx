/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useCallback } from "react";
import { IconButton } from "@vector-im/compound-web";
import { Flex } from "@element-hq/web-shared-components";
import MicOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/mic-on-solid";
import MicOffIcon from "@vector-im/compound-design-tokens/assets/web/icons/mic-off-solid";
import VideoCallOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/video-call-solid";
import VideoCallOffIcon from "@vector-im/compound-design-tokens/assets/web/icons/video-call-off-solid";
import classNames from "classnames";

import { _t } from "../../../languageHandler";
import { useSettingValue } from "../../../hooks/useSettings";
import { type CallDevice, setCallDeviceEnabledByDefault } from "../../../utils/call-device-defaults";

interface ToggleProps {
    device: CallDevice;
    enabled: boolean;
    tooltip: string;
    children: JSX.Element;
}

const DeviceToggle = ({ device, enabled, tooltip, children }: ToggleProps): JSX.Element => {
    const onClick = useCallback(() => {
        // Fire and forget: the setting write is local, and the button re-renders
        // off the setting watcher rather than off this promise.
        void setCallDeviceEnabledByDefault(device, !enabled);
    }, [device, enabled]);

    return (
        <IconButton
            className={classNames("mx_CallDeviceDefaults_button", {
                mx_CallDeviceDefaults_button_off: !enabled,
            })}
            size="32px"
            tooltip={tooltip}
            tooltipPlacement="top"
            onClick={onClick}
        >
            {children}
        </IconButton>
    );
};

/**
 * The microphone and camera toggles at the foot of the left panel.
 *
 * These do not control any call that is currently running - they say how the
 * next one is joined, so that the user can arrive in a room already muted
 * instead of having to mute once they are in and audible.
 */
export const CallDeviceDefaults = (): JSX.Element => {
    const micEnabled = !useSettingValue("audioInputMuted");
    const cameraEnabled = !useSettingValue("videoInputMuted");

    return (
        <Flex
            as="section"
            className="mx_CallDeviceDefaults"
            align="center"
            gap="var(--cpd-space-1x)"
            aria-label={_t("voip|default_devices|label")}
        >
            <DeviceToggle
                device="audio"
                enabled={micEnabled}
                tooltip={
                    micEnabled
                        ? _t("voip|default_devices|disable_microphone")
                        : _t("voip|default_devices|enable_microphone")
                }
            >
                {micEnabled ? <MicOnIcon /> : <MicOffIcon />}
            </DeviceToggle>
            <DeviceToggle
                device="video"
                enabled={cameraEnabled}
                tooltip={
                    cameraEnabled ? _t("voip|default_devices|disable_camera") : _t("voip|default_devices|enable_camera")
                }
            >
                {cameraEnabled ? <VideoCallOnIcon /> : <VideoCallOffIcon />}
            </DeviceToggle>
        </Flex>
    );
};
