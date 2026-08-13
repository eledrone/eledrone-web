/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { act, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import type { MatrixClient, Room, RoomMember } from "matrix-js-sdk/src/matrix";
import { stubClient } from "../../../../test/test-utils";
import { CallPanel } from "./CallPanel";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import { isCallDeviceEnabledByDefault, type DeviceMuteState } from "../../../utils/call-device-defaults";
import { CallEvent, ConnectionState, ElementCall } from "../../../models/Call";
import { CallStore } from "../../../stores/CallStore";
import { OwnProfileStore } from "../../../stores/OwnProfileStore";
import { SDKContext } from "../../../contexts/SDKContext";
import { SDKContextClass } from "../../../contexts/SDKContextClass";
import defaultDispatcher from "../../../dispatcher/dispatcher";
import { Action } from "../../../dispatcher/actions";

let client: MatrixClient;
let sdkContext: SDKContextClass;

/** A participants map containing this device, i.e. a call we are really in. */
const ourParticipants = (): Map<RoomMember, Set<string>> =>
    new Map([[{ userId: client.getUserId()! } as RoomMember, new Set([client.getDeviceId()!])]]);

/** A participants map containing somebody else, but not us. */
const someoneElsesParticipants = (): Map<RoomMember, Set<string>> =>
    new Map([[{ userId: "@other:example.org" } as RoomMember, new Set(["OTHERDEVICE"])]]);

/**
 * A stand-in for a connected call.
 *
 * It has to pass `instanceof ElementCall`, because that is how the panel decides
 * a call is one whose devices it can drive - so it is built from the prototype
 * rather than being a separate mock class, with a real emitter behind the event
 * methods the hooks subscribe with.
 */
const mockCall = (
    deviceMuteState: Required<DeviceMuteState>,
    participants: Map<RoomMember, Set<string>> = ourParticipants(),
): ElementCall => {
    const emitter = new TypedEventEmitter<CallEvent, any>();
    const call = Object.create(ElementCall.prototype) as ElementCall;

    Object.defineProperty(call, "roomId", { value: "!room:example.org" });
    Object.defineProperty(call, "deviceMuteState", { value: deviceMuteState, writable: true });
    Object.defineProperty(call, "participants", { value: participants, writable: true });
    Object.defineProperty(call, "connectionState", { value: ConnectionState.Connected, writable: true });
    Object.assign(call, {
        setDeviceMute: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        on: emitter.on.bind(emitter),
        off: emitter.off.bind(emitter),
        emit: emitter.emit.bind(emitter),
        addListener: emitter.on.bind(emitter),
        removeListener: emitter.off.bind(emitter),
    });

    return call;
};

const renderPanel = (): ReturnType<typeof render> =>
    render(<CallPanel />, {
        wrapper: ({ children }) => (
            // The settings button reaches for the current room through the SDK
            // context, the way it did in the space rail it came from.
            <SDKContext.Provider value={sdkContext}>
                <MatrixClientContext.Provider value={client}>{children}</MatrixClientContext.Provider>
            </SDKContext.Provider>
        ),
    });

describe("<CallPanel />", () => {
    beforeEach(async () => {
        // A fully stubbed client, not a hand-rolled one: touching
        // CallStore.instance starts the store, which reaches for RTC transports
        // and the room list, and a missing method there throws where nothing
        // catches it and takes the test worker down with it.
        client = stubClient();
        // stubClient sets the peg, which is where SDKContextClass reads its
        // client from, so the shared instance is already pointed at it.
        sdkContext = SDKContextClass.instance;
        // The panel's avatar is the user menu, whose view model asks for these
        // on construction. stubClient does not provide getAuthMetadata, and the
        // resulting rejection is not awaited anywhere, so it surfaces as an
        // unhandled rejection that takes the worker down rather than as a
        // failing assertion.
        client.getAuthMetadata = vi.fn().mockResolvedValue(undefined);
        // That same view model leaks a listener on the profile store per
        // instance - its snapshot builds a status view model nothing disposes -
        // and the store is a singleton, so a suite of any size trips Node's
        // ten-listener warning.
        OwnProfileStore.instance.setMaxListeners(100);
        vi.spyOn(client, "getRoom").mockReturnValue({ name: "Мотыки" } as unknown as Room);
        CallStore.instance.connectedCalls.clear();
        await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, false);
    });

    afterEach(() => {
        CallStore.instance.connectedCalls.clear();
    });

    describe("when not in a call", () => {
        it("shows who you are, and does not show call controls", () => {
            renderPanel();

            expect(screen.getByText("Online")).toBeInTheDocument();
            expect(screen.queryByText("Voice Connected")).not.toBeInTheDocument();
            expect(screen.queryByLabelText("Disconnect")).not.toBeInTheDocument();
        });

        it("mutes the microphone for the next call rather than a running one", async () => {
            renderPanel();

            await userEvent.click(screen.getByLabelText("Mute microphone"));

            await waitFor(() => expect(isCallDeviceEnabledByDefault("audio")).toBe(false));
        });

        it("opens the user menu from the avatar", async () => {
            const { baseElement } = renderPanel();

            await userEvent.click(screen.getByLabelText("User menu"));

            // The menu is portalled, so it is not under the panel in the DOM
            await waitFor(() => expect(baseElement.querySelector("div[aria-label='User menu']")).toBeInTheDocument());
        });

        it("opens the user menu via the dispatcher, as the space rail used to", async () => {
            const { baseElement } = renderPanel();

            defaultDispatcher.dispatch({ action: Action.ToggleUserMenu });

            await waitFor(() => expect(baseElement.querySelector("div[aria-label='User menu']")).toBeInTheDocument());
        });

        it("opens quick settings from the gear, with the voice settings in it", async () => {
            renderPanel();

            await userEvent.click(screen.getByLabelText("Quick settings"));

            expect(await screen.findByText("All settings")).toBeInTheDocument();
            expect(screen.getByText("Voice & Video")).toBeInTheDocument();
        });

        it("stretches its rows, and its lines of text, to the width they are given", () => {
            const { container } = renderPanel();

            // Flex defaults to align-items: start, which in a column container
            // is what sizes children horizontally. Left at the default the rows
            // sat at their intrinsic ~210px, short of the sidebar's edge, and
            // the lines of text took their full length and overflowed instead
            // of truncating - an ellipsis needs a box narrower than its text.
            for (const el of [
                screen.getByTestId("call-panel"),
                container.querySelector<HTMLElement>(".mx_CallPanel_userText")!,
            ]) {
                expect(el.style.getPropertyValue("--mx-flex-align")).toBe("stretch");
            }
        });

        it("shows deafen, but not as something that works yet", () => {
            renderPanel();

            // Compound's IconButton marks itself with aria-disabled rather than
            // the disabled attribute.
            expect(screen.getByLabelText("Deafen (not yet available)")).toHaveAttribute("aria-disabled", "true");
        });
    });

    describe("when in a call", () => {
        it("shows what you are connected to, with the controls for it", () => {
            CallStore.instance.connectedCalls.add(mockCall({ audio_enabled: true, video_enabled: false }));
            renderPanel();

            expect(screen.getByText("Voice Connected")).toBeInTheDocument();
            expect(screen.getByText("Мотыки")).toBeInTheDocument();
            expect(screen.getByText("In voice")).toBeInTheDocument();
            expect(screen.getByLabelText("Disconnect")).toBeInTheDocument();
        });

        it("mutes the running call instead of the setting", async () => {
            const call = mockCall({ audio_enabled: true, video_enabled: false });
            CallStore.instance.connectedCalls.add(call);
            renderPanel();

            await userEvent.click(screen.getByLabelText("Mute microphone"));

            expect(call.setDeviceMute).toHaveBeenCalledWith({ audio_enabled: false });
            // The join default is a separate choice and must be left alone
            expect(isCallDeviceEnabledByDefault("audio")).toBe(true);
        });

        it("turns the camera on in the call it is already in", async () => {
            const call = mockCall({ audio_enabled: true, video_enabled: false });
            CallStore.instance.connectedCalls.add(call);
            renderPanel();

            await userEvent.click(screen.getByLabelText("Turn on camera"));

            expect(call.setDeviceMute).toHaveBeenCalledWith({ video_enabled: true });
        });

        it("reflects the state the call reports, not the state it was asked for", () => {
            // The call's own buttons are equally in charge, so the panel follows
            // what the widget says rather than assuming its request was obeyed.
            CallStore.instance.connectedCalls.add(mockCall({ audio_enabled: false, video_enabled: true }));
            renderPanel();

            expect(screen.getByLabelText("Unmute microphone")).toBeInTheDocument();
            expect(screen.getByLabelText("Turn off camera")).toBeInTheDocument();
        });

        it("hangs up when disconnect is pressed", async () => {
            const call = mockCall({ audio_enabled: true, video_enabled: false });
            CallStore.instance.connectedCalls.add(call);
            renderPanel();

            await userEvent.click(screen.getByLabelText("Disconnect"));

            expect(call.disconnect).toHaveBeenCalled();
        });

        it("says so while the call is on its way out, and will not hang up twice", () => {
            const call = mockCall({ audio_enabled: true, video_enabled: false });
            Object.defineProperty(call, "connectionState", { value: ConnectionState.Disconnecting });
            CallStore.instance.connectedCalls.add(call);
            renderPanel();

            expect(screen.getByText("Disconnecting…")).toBeInTheDocument();
            expect(screen.getByLabelText("Disconnect")).toHaveAttribute("aria-disabled", "true");
        });

        it("still shows the call before our own membership has landed", () => {
            // Between joining and the membership arriving we are legitimately
            // not a participant yet, and that is not the same as having left.
            CallStore.instance.connectedCalls.add(mockCall({ audio_enabled: true, video_enabled: false }, new Map()));
            renderPanel();

            expect(screen.getByText("Voice Connected")).toBeInTheDocument();
        });

        it("counts how long the call has been up", () => {
            vi.useFakeTimers();
            try {
                CallStore.instance.connectedCalls.add(mockCall({ audio_enabled: true, video_enabled: false }));
                renderPanel();

                expect(screen.getByText("00:00")).toBeInTheDocument();

                act(() => {
                    vi.advanceTimersByTime(65_000);
                });

                expect(screen.getByText("01:05")).toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });

        it("counts from the moment of rejoining, not of the first join", () => {
            // The Call object outlives the connection - it belongs to the room,
            // not to the visit - so a timer keyed to the object rather than to
            // the connection would come back mid-count on rejoining.
            vi.useFakeTimers();
            try {
                const call = mockCall({ audio_enabled: true, video_enabled: false });
                CallStore.instance.connectedCalls.add(call);
                renderPanel();

                act(() => {
                    vi.advanceTimersByTime(30_000);
                });
                expect(screen.getByText("00:30")).toBeInTheDocument();

                act(() => {
                    Object.defineProperty(call, "participants", { value: someoneElsesParticipants() });
                    call.emit(CallEvent.Participants, call.participants, new Map());
                });
                expect(screen.queryByText("Voice Connected")).not.toBeInTheDocument();

                act(() => {
                    Object.defineProperty(call, "participants", { value: ourParticipants() });
                    call.emit(CallEvent.Participants, call.participants, new Map());
                });

                expect(screen.getByText("00:00")).toBeInTheDocument();
            } finally {
                vi.useRealTimers();
            }
        });

        it("drops the call once our own device is no longer in it", async () => {
            const call = mockCall({ audio_enabled: true, video_enabled: false });
            CallStore.instance.connectedCalls.add(call);
            renderPanel();
            expect(screen.getByText("Voice Connected")).toBeInTheDocument();

            // The widget left without telling us; only the memberships say so.
            Object.defineProperty(call, "participants", { value: someoneElsesParticipants() });
            call.emit(CallEvent.Participants, call.participants, new Map());

            await waitFor(() => expect(screen.queryByText("Voice Connected")).not.toBeInTheDocument());
            expect(screen.getByText("Online")).toBeInTheDocument();
        });
    });
});
