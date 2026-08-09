/*
Copyright 2023, 2024 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import type { Streams } from "electron";

type DisplayMediaCallback = (streams: Streams) => void;

let displayMediaCallback: DisplayMediaCallback | null;
// Whether the pending request asked for audio. The callback is invoked later, from the IPC handler
// that receives the source the user picked, by which point the original request object is long gone -
// so the flag has to be carried alongside the callback.
let displayMediaAudioRequested = false;

export const getDisplayMediaCallback = (): DisplayMediaCallback | null => {
    return displayMediaCallback;
};

export const isDisplayMediaAudioRequested = (): boolean => {
    return displayMediaAudioRequested;
};

export const setDisplayMediaCallback = (callback: DisplayMediaCallback | null, audioRequested = false): void => {
    displayMediaCallback = callback;
    displayMediaAudioRequested = audioRequested;
};
