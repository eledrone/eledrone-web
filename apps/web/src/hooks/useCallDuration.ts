/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { useEffect, useRef, useState } from "react";

import { type ElementCall } from "../models/Call";

/**
 * How long the given call has been connected, in whole seconds.
 *
 * The clock starts when this hook first sees the call, which is the moment it
 * connects: a call only reaches {@link CallStore.connectedCalls} - and so only
 * reaches the panel that renders this - once its state is Connected, and it
 * leaves that set again on disconnect. So hanging up and rejoining the same
 * room starts a new count even though it is the same `Call` object, which is
 * what anybody watching the number would expect.
 *
 * The elapsed time is recomputed from the start each tick rather than
 * accumulated, so a slow or throttled interval shows the right number late
 * rather than the wrong number on time.
 */
export const useCallDuration = (call: ElementCall): number => {
    const since = useRef(0);
    const [seconds, setSeconds] = useState(0);

    useEffect(() => {
        since.current = Date.now();
        setSeconds(0);

        const interval = window.setInterval(() => {
            setSeconds(Math.max(0, Math.floor((Date.now() - since.current) / 1000)));
        }, 1000);
        return () => window.clearInterval(interval);
    }, [call]);

    return seconds;
};
