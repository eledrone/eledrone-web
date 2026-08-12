/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useCallback, useRef, useState } from "react";
import { type MatrixClient } from "matrix-js-sdk/src/matrix";

import { CallEvent, ElementCall } from "../models/Call";
import { type DeviceMuteState } from "../utils/call-device-defaults";
import { CallStore, CallStoreEvent } from "../stores/CallStore";
import { useEventEmitter, useTypedEventEmitterState } from "./useEventEmitter";
import { useMatrixClientContext } from "../contexts/MatrixClientContext";

/** Whether this device is among the call's participants. */
const hasOwnDevice = (call: ElementCall, client: MatrixClient): boolean => {
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (userId === null || deviceId === null) return false;

    for (const [member, devices] of call.participants) {
        if (member.userId === userId && devices.has(deviceId)) return true;
    }
    return false;
};

/**
 * The call the user is currently in, if any.
 *
 * The left panel is not tied to a room, so unlike {@link useCall} this asks the
 * store what is connected rather than what exists in some particular room. Only
 * one call can be connected at a time - Element Call disconnects the others when
 * a new one is joined - so the first is the only one.
 *
 * Narrowed to {@link ElementCall} because the panel's job is to drive the call,
 * and the device_mute action that does the driving is Element Call's. A legacy
 * Jitsi call is reported as no call rather than as one with dead buttons.
 *
 * The store's word is then checked against the call's own participants: once
 * this device has appeared among them, its disappearance means we are out of the
 * call whatever the store still believes. {@link ElementCall} has its own
 * watchdog for that, so this is a second line of defence rather than the
 * mechanism - but the panel is the one place where being wrong about it is
 * visible the whole time, so it is worth being sure here.
 */
export const useConnectedCall = (): ElementCall | null => {
    const client = useMatrixClientContext();

    const fromStore = (): ElementCall | null => {
        for (const call of CallStore.instance.connectedCalls) {
            if (call instanceof ElementCall) return call;
        }
        return null;
    };

    const [call, setCall] = useState<ElementCall | null>(fromStore);
    useEventEmitter(CallStore.instance, CallStoreEvent.ConnectedCalls, () => setCall(fromStore()));
    // Re-render whenever the call's participants change, so the check below is
    // made again against the current ones.
    useTypedEventEmitterState(
        call ?? undefined,
        CallEvent.Participants,
        useCallback((participants) => participants ?? call?.participants, [call]),
    );

    // Between joining and our membership landing there is a window in which we
    // are legitimately not a participant yet, so absence only counts against a
    // call we have already been seen in.
    const seen = useRef(false);
    if (call === null) {
        seen.current = false;
        return null;
    }

    if (hasOwnDevice(call, client)) {
        seen.current = true;
        return call;
    }
    return seen.current ? null : call;
};

/**
 * The mic and camera state the given call reports being in, or null while it has
 * not said yet - the moment between joining and the widget's first report.
 */
export const useDeviceMuteState = (call: ElementCall | null): Required<DeviceMuteState> | null =>
    useTypedEventEmitterState(
        call ?? undefined,
        CallEvent.DeviceMuteState,
        useCallback((state) => state ?? call?.deviceMuteState ?? null, [call]),
    );
