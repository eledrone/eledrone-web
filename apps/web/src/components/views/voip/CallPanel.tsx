/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, type ReactNode, useCallback } from "react";
import { IconButton } from "@vector-im/compound-web";
import { Flex, useCreateAutoDisposedViewModel, UserMenu } from "@element-hq/web-shared-components";
import MicOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/mic-on-solid";
import MicOffIcon from "@vector-im/compound-design-tokens/assets/web/icons/mic-off-solid";
import VideoCallOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/video-call-solid";
import VideoCallOffIcon from "@vector-im/compound-design-tokens/assets/web/icons/video-call-off-solid";
import VolumeOnIcon from "@vector-im/compound-design-tokens/assets/web/icons/volume-on-solid";
import ShareScreenIcon from "@vector-im/compound-design-tokens/assets/web/icons/share-screen-solid";
import EndCallIcon from "@vector-im/compound-design-tokens/assets/web/icons/end-call";
import VoiceCallIcon from "@vector-im/compound-design-tokens/assets/web/icons/voice-call";
import classNames from "classnames";

import { _t } from "../../../languageHandler";
import { useSettingValue } from "../../../hooks/useSettings";
import { setCallDeviceEnabledByDefault } from "../../../utils/call-device-defaults";
import { useConnectedCall, useDeviceMuteState } from "../../../hooks/useConnectedCall";
import { CallEvent, ConnectionState, type ElementCall } from "../../../models/Call";
import { useEventEmitterState, useTypedEventEmitterState } from "../../../hooks/useEventEmitter";
import { OwnProfileStore } from "../../../stores/OwnProfileStore";
import { UPDATE_EVENT } from "../../../stores/AsyncStore";
import { useMatrixClientContext } from "../../../contexts/MatrixClientContext";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";
import { useDispatcher } from "../../../hooks/useDispatcher";
import { UserMenuViewModel } from "../../../viewmodels/menus/UserMenuViewModel";
import QuickSettingsButton from "../spaces/QuickSettingsButton";

interface PanelButtonProps {
    label: string;
    on?: boolean;
    disabled?: boolean;
    onClick?: () => void;
    className?: string;
    children: ReactNode;
}

/**
 * One of the panel's controls. `on` is what colours it: off is the state worth
 * noticing at a glance, so that is the one that goes red.
 */
const PanelButton = ({ label, on = true, disabled, onClick, className, children }: PanelButtonProps): JSX.Element => (
    <IconButton
        className={classNames("mx_CallPanel_button", className, { mx_CallPanel_button_off: !on })}
        size="32px"
        tooltip={label}
        tooltipPlacement="top"
        disabled={disabled}
        onClick={onClick}
    >
        {children}
    </IconButton>
);

/**
 * The controls that only exist while in a call: what you are connected to, and
 * the things you can do about it.
 *
 * The status line, noise suppression and screen share are placeholders. They are
 * rendered rather than hidden so the panel does not change shape when they start
 * working, and disabled so they cannot be mistaken for working now.
 */
const InCallSection = ({ call }: { call: ElementCall }): JSX.Element => {
    const client = useMatrixClientContext();
    const muteState = useDeviceMuteState(call);
    const cameraOn = muteState?.video_enabled ?? false;
    // Call.room is protected, so the name comes from the client instead.
    const roomName = client.getRoom(call.roomId)?.name ?? "";

    // Hanging up is bounded to a few seconds even against a dead widget, so
    // this window is short; it exists so a second press cannot land on a call
    // that is already on its way out.
    const disconnecting = useTypedEventEmitterState(
        call,
        CallEvent.ConnectionState,
        useCallback((state) => (state ?? call.connectionState) === ConnectionState.Disconnecting, [call]),
    );

    const onCameraClick = useCallback(() => {
        void call.setDeviceMute({ video_enabled: !cameraOn });
    }, [call, cameraOn]);

    const onHangupClick = useCallback(() => {
        void call.disconnect();
    }, [call]);

    return (
        // align=stretch, because Flex defaults to start and in a column that is
        // what sizes the rows horizontally - they would shrink to their content
        // and leave the panel short of the sidebar's edge.
        <Flex as="section" className="mx_CallPanel_call" direction="column" align="stretch" gap="var(--cpd-space-2x)">
            <Flex align="center" gap="var(--cpd-space-2x)">
                <VoiceCallIcon className="mx_CallPanel_callIcon" width="20px" height="20px" />
                {/* align=stretch so the lines are held to the column's width.
                    Left at the default, they take their full text width and
                    overflow instead of truncating - the ellipsis needs a box
                    narrower than the text to appear at all. */}
                <Flex direction="column" align="stretch" className="mx_CallPanel_callStatus">
                    <span className="mx_CallPanel_callStatus_state">
                        {disconnecting ? _t("voip|call_panel|disconnecting") : _t("voip|call_panel|connected")}
                    </span>
                    <span className="mx_CallPanel_callStatus_room" title={roomName}>
                        {roomName}
                    </span>
                </Flex>
                <PanelButton label={_t("voip|call_panel|noise_suppression")} disabled>
                    <VolumeOnIcon />
                </PanelButton>
                <PanelButton
                    label={_t("voip|call_panel|disconnect")}
                    on={false}
                    disabled={disconnecting}
                    onClick={onHangupClick}
                    className="mx_CallPanel_button_hangup"
                >
                    <EndCallIcon />
                </PanelButton>
            </Flex>
            <Flex align="center" gap="var(--cpd-space-1x)">
                <PanelButton
                    label={cameraOn ? _t("voip|call_panel|camera_off") : _t("voip|call_panel|camera_on")}
                    on={cameraOn}
                    onClick={onCameraClick}
                >
                    {cameraOn ? <VideoCallOnIcon /> : <VideoCallOffIcon />}
                </PanelButton>
                <PanelButton label={_t("voip|call_panel|share_screen")} disabled>
                    <ShareScreenIcon />
                </PanelButton>
            </Flex>
        </Flex>
    );
};

/**
 * The panel at the foot of the room list: who you are, and how you sound.
 *
 * The microphone means two different things depending on whether there is a call
 * to apply it to. In one, it says how the next call is joined; in the other it
 * mutes the call in progress. Both are "am I audible", which is why it is one
 * button rather than two.
 */
export const CallPanel = (): JSX.Element => {
    const client = useMatrixClientContext();
    const call = useConnectedCall();
    const muteState = useDeviceMuteState(call);

    const micDefaultOn = !useSettingValue("audioInputMuted");
    // In a call, what the call says; otherwise what the next one will start as.
    const micOn = call === null ? micDefaultOn : (muteState?.audio_enabled ?? false);

    const displayName = useEventEmitterState(
        OwnProfileStore.instance,
        UPDATE_EVENT,
        () => OwnProfileStore.instance.displayName ?? client.getUserId()!,
    );

    // The avatar is the user menu's trigger, the same one the space rail used to
    // carry. Collapsed, so the menu does not repeat the display name that is
    // already in the row beside it.
    const userMenuVm = useCreateAutoDisposedViewModel(
        () => new UserMenuViewModel({ ownProfileStore: OwnProfileStore.instance }, defaultDispatcher, client, true),
    );

    useDispatcher(defaultDispatcher, (payload) => {
        if (payload.action === Action.ToggleUserMenu) {
            userMenuVm.setOpen(!userMenuVm.getSnapshot().open);
        }
    });

    const onMicClick = useCallback(() => {
        if (call === null) {
            // Fire and forget: the write is local and the button re-renders off
            // the setting watcher, not off this promise.
            void setCallDeviceEnabledByDefault("audio", !micOn);
        } else {
            void call.setDeviceMute({ audio_enabled: !micOn });
        }
    }, [call, micOn]);

    return (
        <Flex
            as="section"
            className="mx_CallPanel"
            direction="column"
            // See the note in InCallSection: without this the rows size to their
            // content rather than to the panel.
            align="stretch"
            aria-label={_t("voip|call_panel|label")}
            data-testid="call-panel"
        >
            {call !== null && <InCallSection call={call} />}
            <Flex align="center" gap="var(--cpd-space-2x)" className="mx_CallPanel_user">
                <UserMenu vm={userMenuVm} className="mx_CallPanel_userMenu" side="top" align="start" />
                {/* See the note in InCallSection about align=stretch */}
                <Flex direction="column" align="stretch" className="mx_CallPanel_userText">
                    <span className="mx_CallPanel_userText_name">{displayName}</span>
                    <span className="mx_CallPanel_userText_status">
                        {call === null ? _t("presence|online") : _t("voip|call_panel|in_voice")}
                    </span>
                </Flex>
                <PanelButton
                    label={micOn ? _t("voip|call_panel|mic_off") : _t("voip|call_panel|mic_on")}
                    on={micOn}
                    onClick={onMicClick}
                >
                    {micOn ? <MicOnIcon /> : <MicOffIcon />}
                </PanelButton>
                {/* Deafen needs Element Call to stop playing everyone else, which
                    it cannot be asked to do yet. Shown so the panel is the right
                    shape, disabled so it does not pretend to work. */}
                <PanelButton label={_t("voip|call_panel|deafen")} disabled>
                    <VolumeOnIcon />
                </PanelButton>
                {/* The quick settings the space rail used to carry, moved here
                    with the rest of what the user does to themselves. */}
                <span className="mx_CallPanel_settings">
                    <QuickSettingsButton isPanelCollapsed tooltipPlacement="top" />
                </span>
            </Flex>
        </Flex>
    );
};
