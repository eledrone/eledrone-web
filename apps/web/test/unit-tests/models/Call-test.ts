/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import EventEmitter from "node:events";
import { mocked } from "jest-mock";
import { waitFor } from "jest-matrix-react";
import {
    RoomType,
    type Room,
    RoomEvent,
    MatrixEvent,
    type MatrixClient,
    type IMyDevice,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership } from "matrix-js-sdk/src/types";
import { Widget } from "matrix-widget-api";
import {
    type CallMembership,
    MatrixRTCSessionManagerEvents,
    MatrixRTCSession,
    MatrixRTCSessionEvent,
} from "matrix-js-sdk/src/matrixrtc";
import { CallType } from "matrix-js-sdk/src/webrtc/call";

import type { Mocked } from "jest-mock";
import type { ClientWidgetApi } from "matrix-widget-api";
import {
    type JitsiCallMemberContent,
    Call,
    CallEvent,
    ConnectionState,
    JitsiCall,
    ElementCall,
    ElementCallIntent,
} from "../../../src/models/Call";
import { cleanUpClientRoomAndStores, enableCalls, mockPlatformPeg, setUpClientRoomAndStores } from "../../test-utils";
import WidgetStore from "../../../src/stores/WidgetStore";
import { WidgetMessagingStore } from "../../../src/stores/widgets/WidgetMessagingStore";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../../../src/stores/ActiveWidgetStore";
import { ElementWidgetActions } from "../../../src/stores/widgets/ElementWidgetActions";
import SettingsStore from "../../../src/settings/SettingsStore";
import { SettingLevel } from "../../../src/settings/SettingLevel";
import { Anonymity, PosthogAnalytics } from "../../../src/PosthogAnalytics";
import { type SettingKey } from "../../../src/settings/Settings.tsx";
import SdkConfig from "../../../src/SdkConfig.ts";
import DMRoomMap from "../../../src/utils/DMRoomMap.ts";
import { WidgetMessagingEvent, type WidgetMessaging } from "../../../src/stores/widgets/WidgetMessaging.ts";
import { BugReportEndpointURLLocal } from "../../../src/IConfigOptions.ts";

const { enabledSettings } = enableCalls();

const setUpWidget = (
    call: Call,
): { widget: Widget; messaging: Mocked<WidgetMessaging>; widgetApi: Mocked<ClientWidgetApi> } => {
    call.widget.data = { ...call.widget, skipLobby: true };
    const widget = new Widget(call.widget);

    const widgetApi = new (class extends EventEmitter {
        transport = {
            send: jest.fn(),
            reply: jest.fn(),
        };
    })() as unknown as Mocked<ClientWidgetApi>;
    const messaging = new (class extends EventEmitter {
        stop = jest.fn();
        widgetApi = widgetApi;
    })() as unknown as Mocked<WidgetMessaging>;
    WidgetMessagingStore.instance.storeMessaging(widget, call.roomId, messaging);

    return { widget, messaging, widgetApi };
};

async function connect(call: Call, widgetApi: Mocked<ClientWidgetApi>, startWidget = true): Promise<void> {
    async function sessionConnect() {
        await new Promise<void>((r) => {
            setTimeout(() => r(), 400);
        });
        widgetApi.emit(`action:${ElementWidgetActions.JoinCall}`, new CustomEvent("widgetapirequest", {}));
    }
    async function runTimers() {
        jest.advanceTimersByTime(500);
        jest.advanceTimersByTime(500);
    }
    sessionConnect();
    await Promise.all([...(startWidget ? [call.start()] : []), runTimers()]);
}

async function disconnect(call: Call, widgetApi: Mocked<ClientWidgetApi>): Promise<void> {
    async function sessionDisconnect() {
        await new Promise<void>((r) => {
            setTimeout(() => r(), 400);
        });
        widgetApi.emit(`action:${ElementWidgetActions.HangupCall}`, new CustomEvent("widgetapirequest", {}));
    }
    async function runTimers() {
        jest.advanceTimersByTime(500);
        jest.advanceTimersByTime(500);
    }
    sessionDisconnect();
    const promise = call.disconnect();
    runTimers();
    await promise;
}

const cleanUpCallAndWidget = (call: Call, widget: Widget) => {
    call.destroy();
    jest.clearAllMocks();
    WidgetMessagingStore.instance.stopMessaging(widget, call.roomId);
};

describe("JitsiCall", () => {
    mockPlatformPeg({ supportsJitsiScreensharing: () => true });

    let client: Mocked<MatrixClient>;
    let room: Room;
    let alice: RoomMember;
    let bob: RoomMember;
    let carol: RoomMember;

    beforeEach(() => {
        ({ client, room, alice, bob, carol } = setUpClientRoomAndStores());
        jest.spyOn(room, "getType").mockReturnValue(RoomType.ElementVideo);
    });

    afterEach(() => cleanUpClientRoomAndStores(client, room));

    describe("get", () => {
        it("finds no calls", () => {
            expect(Call.get(room)).toBeNull();
        });

        it("finds calls", async () => {
            await JitsiCall.create(room);
            expect(Call.get(room)).toBeInstanceOf(JitsiCall);
        });

        it("ignores terminated calls", async () => {
            await JitsiCall.create(room);

            // Terminate the call
            const [event] = room.currentState.getStateEvents("im.vector.modular.widgets");
            await client.sendStateEvent(room.roomId, "im.vector.modular.widgets", {}, event.getStateKey()!);

            expect(Call.get(room)).toBeNull();
        });
    });

    describe("instance in a video room", () => {
        let call: JitsiCall;
        let widget: Widget;
        let messaging: Mocked<WidgetMessaging>;
        let widgetApi: Mocked<ClientWidgetApi>;

        beforeEach(async () => {
            jest.useFakeTimers();
            jest.setSystemTime(0);

            await JitsiCall.create(room);
            const maybeCall = JitsiCall.get(room);
            if (maybeCall === null) throw new Error("Failed to create call");
            call = maybeCall;

            ({ widget, messaging, widgetApi } = setUpWidget(call));

            mocked(widgetApi.transport).send.mockImplementation(async (action, data): Promise<any> => {
                if (action === ElementWidgetActions.JoinCall) {
                    widgetApi.emit(
                        `action:${ElementWidgetActions.JoinCall}`,
                        new CustomEvent("widgetapirequest", { detail: { data } }),
                    );
                } else if (action === ElementWidgetActions.HangupCall) {
                    widgetApi.emit(
                        `action:${ElementWidgetActions.HangupCall}`,
                        new CustomEvent("widgetapirequest", { detail: { data } }),
                    );
                }
                return {};
            });
        });

        afterEach(() => cleanUpCallAndWidget(call, widget));

        it("connects", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
        });

        it("waits for messaging when starting", async () => {
            // Temporarily remove the messaging to simulate connecting while the
            // widget is still initializing
            WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            const startup = call.start();
            WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, messaging);
            await startup;
            await connect(call, widgetApi, false);
            expect(call.connectionState).toBe(ConnectionState.Connected);
        });

        it("disconnects anyway if the widget returns an error", async () => {
            await connect(call, widgetApi);
            mocked(widgetApi.transport).send.mockRejectedValue(new Error("never!"));

            // Telling the widget is best effort; ending the call is not
            await expect(call.disconnect()).resolves.toBeUndefined();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("handles remote disconnection", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);

            const callback = jest.fn();

            call.on(CallEvent.ConnectionState, callback);

            widgetApi.emit(`action:${ElementWidgetActions.HangupCall}`, new CustomEvent("widgetapirequest", {}));
            await waitFor(() => {
                expect(callback).toHaveBeenNthCalledWith(1, ConnectionState.Disconnected, ConnectionState.Connected);
            });
            // in video rooms we expect the call to immediately reconnect
            call.off(CallEvent.ConnectionState, callback);
        });

        it("disconnects", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            await call.disconnect();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("disconnects when we leave the room", async () => {
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            room.emit(RoomEvent.MyMembership, room, KnownMembership.Leave);
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("reconnects after disconnect in video rooms", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            await call.disconnect();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("remains connected if we stay in the room", async () => {
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            room.emit(RoomEvent.MyMembership, room, KnownMembership.Join);
            expect(call.connectionState).toBe(ConnectionState.Connected);
        });

        it("tracks participants in room state", async () => {
            expect(call.participants).toEqual(new Map());

            // A participant with multiple devices (should only show up once)
            await client.sendStateEvent(
                room.roomId,
                JitsiCall.MEMBER_EVENT_TYPE,
                { devices: ["bobweb", "bobdesktop"], expires_ts: 1000 * 60 * 10 },
                bob.userId,
            );
            // A participant with an expired device (should not show up)
            await client.sendStateEvent(
                room.roomId,
                JitsiCall.MEMBER_EVENT_TYPE,
                { devices: ["carolandroid"], expires_ts: -1000 * 60 },
                carol.userId,
            );

            // Now, stub out client.sendStateEvent so we can test our local echo
            client.sendStateEvent.mockReset();
            await connect(call, widgetApi);
            expect(call.participants).toEqual(
                new Map([
                    [alice, new Set(["alices_device"])],
                    [bob, new Set(["bobweb", "bobdesktop"])],
                ]),
            );

            await call.disconnect();
            expect(call.participants).toEqual(new Map([[bob, new Set(["bobweb", "bobdesktop"])]]));
        });

        it("updates room state when connecting and disconnecting", async () => {
            await connect(call, widgetApi);
            const now1 = Date.now();
            await waitFor(
                () =>
                    expect(
                        room.currentState.getStateEvents(JitsiCall.MEMBER_EVENT_TYPE, alice.userId)?.getContent(),
                    ).toEqual({
                        devices: [client.getDeviceId()],
                        expires_ts: now1 + call.STUCK_DEVICE_TIMEOUT_MS,
                    }),
                { interval: 5 },
            );

            const now2 = Date.now();
            await call.disconnect();
            await waitFor(
                () =>
                    expect(
                        room.currentState.getStateEvents(JitsiCall.MEMBER_EVENT_TYPE, alice.userId)?.getContent(),
                    ).toEqual({
                        devices: [],
                        expires_ts: now2 + call.STUCK_DEVICE_TIMEOUT_MS,
                    }),
                { interval: 5 },
            );
        });

        it("repeatedly updates room state while connected", async () => {
            await connect(call, widgetApi);
            await waitFor(
                () =>
                    expect(client.sendStateEvent).toHaveBeenLastCalledWith(
                        room.roomId,
                        JitsiCall.MEMBER_EVENT_TYPE,
                        { devices: [client.getDeviceId()], expires_ts: expect.any(Number) },
                        alice.userId,
                    ),
                { interval: 5 },
            );

            client.sendStateEvent.mockClear();
            jest.advanceTimersByTime(call.STUCK_DEVICE_TIMEOUT_MS);
            await waitFor(
                () =>
                    expect(client.sendStateEvent).toHaveBeenLastCalledWith(
                        room.roomId,
                        JitsiCall.MEMBER_EVENT_TYPE,
                        { devices: [client.getDeviceId()], expires_ts: expect.any(Number) },
                        alice.userId,
                    ),
                { interval: 5 },
            );
        });

        it("emits events when connection state changes", async () => {
            const onConnectionState = jest.fn();
            call.on(CallEvent.ConnectionState, onConnectionState);

            await connect(call, widgetApi);
            await call.disconnect();
            expect(onConnectionState.mock.calls).toEqual([
                [ConnectionState.Connected, ConnectionState.Disconnected],
                [ConnectionState.Disconnecting, ConnectionState.Connected],
                [ConnectionState.Disconnected, ConnectionState.Disconnecting],
            ]);

            call.off(CallEvent.ConnectionState, onConnectionState);
        });

        it("emits events when participants change", async () => {
            const onParticipants = jest.fn();
            call.on(CallEvent.Participants, onParticipants);

            await connect(call, widgetApi);
            await call.disconnect();
            expect(onParticipants.mock.calls).toEqual([
                [new Map([[alice, new Set(["alices_device"])]]), new Map()],
                [new Map([[alice, new Set(["alices_device"])]]), new Map([[alice, new Set(["alices_device"])]])],
                [new Map(), new Map([[alice, new Set(["alices_device"])]])],
                [new Map(), new Map()],
            ]);

            call.off(CallEvent.Participants, onParticipants);
        });

        it("switches to spotlight layout when the widget becomes a PiP", async () => {
            await connect(call, widgetApi);
            ActiveWidgetStore.instance.emit(ActiveWidgetStoreEvent.Undock);
            expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.SpotlightLayout, {});
            ActiveWidgetStore.instance.emit(ActiveWidgetStoreEvent.Dock);
            expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.TileLayout, {});
        });

        describe("clean", () => {
            const aliceWeb: IMyDevice = {
                device_id: "aliceweb",
                last_seen_ts: 0,
            };
            const aliceDesktop: IMyDevice = {
                device_id: "alicedesktop",
                last_seen_ts: 0,
            };
            const aliceDesktopOffline: IMyDevice = {
                device_id: "alicedesktopoffline",
                last_seen_ts: 1000 * 60 * 60 * -2, // 2 hours ago
            };
            const aliceDesktopNeverOnline: IMyDevice = {
                device_id: "alicedesktopneveronline",
            };

            const mkContent = (devices: IMyDevice[]): JitsiCallMemberContent => ({
                expires_ts: 1000 * 60 * 10,
                devices: devices.map((d) => d.device_id),
            });
            const expectDevices = (devices: IMyDevice[]) =>
                expect(
                    room.currentState.getStateEvents(JitsiCall.MEMBER_EVENT_TYPE, alice.userId)?.getContent(),
                ).toEqual({
                    expires_ts: expect.any(Number),
                    devices: devices.map((d) => d.device_id),
                });

            beforeEach(() => {
                client.getDeviceId.mockReturnValue(aliceWeb.device_id);
                client.getDevices.mockResolvedValue({
                    devices: [aliceWeb, aliceDesktop, aliceDesktopOffline, aliceDesktopNeverOnline],
                });
            });

            it("doesn't clean up valid devices", async () => {
                await connect(call, widgetApi);
                await client.sendStateEvent(
                    room.roomId,
                    JitsiCall.MEMBER_EVENT_TYPE,
                    mkContent([aliceWeb, aliceDesktop]),
                    alice.userId,
                );

                await call.clean();
                expectDevices([aliceWeb, aliceDesktop]);
            });

            it("cleans up our own device if we're disconnected", async () => {
                await client.sendStateEvent(
                    room.roomId,
                    JitsiCall.MEMBER_EVENT_TYPE,
                    mkContent([aliceWeb, aliceDesktop]),
                    alice.userId,
                );

                await call.clean();
                expectDevices([aliceDesktop]);
            });

            it("cleans up devices that have been offline for too long", async () => {
                await client.sendStateEvent(
                    room.roomId,
                    JitsiCall.MEMBER_EVENT_TYPE,
                    mkContent([aliceDesktop, aliceDesktopOffline]),
                    alice.userId,
                );

                await call.clean();
                expectDevices([aliceDesktop]);
            });

            it("cleans up devices that have never been online", async () => {
                await client.sendStateEvent(
                    room.roomId,
                    JitsiCall.MEMBER_EVENT_TYPE,
                    mkContent([aliceDesktop, aliceDesktopNeverOnline]),
                    alice.userId,
                );

                await call.clean();
                expectDevices([aliceDesktop]);
            });

            it("no-ops if there are no state events", async () => {
                await call.clean();
                expect(room.currentState.getStateEvents(JitsiCall.MEMBER_EVENT_TYPE, alice.userId)).toBe(null);
            });
        });
    });
});

describe("ElementCall", () => {
    let client: Mocked<MatrixClient>;
    let room: Room;
    let alice: RoomMember;
    let roomSession: Mocked<MatrixRTCSession>;
    function setRoomMembers(memberIds: string[]) {
        jest.spyOn(room, "getJoinedMembers").mockReturnValue(
            memberIds.map(
                (id) =>
                    ({
                        userId: id,
                    }) as RoomMember,
            ),
        );
    }

    beforeEach(() => {
        jest.useFakeTimers();
        ({ client, room, alice, roomSession } = setUpClientRoomAndStores());
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.useRealTimers();
        SdkConfig.reset();
        cleanUpClientRoomAndStores(client, room);
    });

    describe("get", () => {
        let getUserIdForRoomIdSpy: jest.SpyInstance;

        beforeEach(() => {
            getUserIdForRoomIdSpy = jest.spyOn(DMRoomMap.shared(), "getUserIdForRoomId");
        });

        afterEach(() => {
            Call.get(room)?.destroy();
            getUserIdForRoomIdSpy.mockRestore();
        });

        it("finds no calls", () => {
            expect(Call.get(room)).toBeNull();
        });

        it("finds calls", async () => {
            ElementCall.create(room);
            expect(Call.get(room)).toBeInstanceOf(ElementCall);
        });

        it("should use element call URL from developer settings if present", async () => {
            const originalGetValue = SettingsStore.getValue;
            SettingsStore.getValue = (name: SettingKey, roomId: string | null = null, excludeDefault = false): any => {
                if (name === "Developer.elementCallUrl") {
                    return "https://call.element.dev";
                }
                return excludeDefault
                    ? originalGetValue(name, roomId, excludeDefault)
                    : originalGetValue(name, roomId, excludeDefault);
            };
            await ElementCall.create(room);
            const call = ElementCall.get(room);
            expect(call?.widget.url.startsWith("https://call.element.dev/")).toBeTruthy();
            SettingsStore.getValue = originalGetValue;
        });

        it("finds ongoing calls that are created by the session manager", async () => {
            // There is an existing session created by another user in this room.
            roomSession.memberships.push({} as CallMembership);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");
        });

        it("passes font settings through widget URL", async () => {
            const originalGetValue = SettingsStore.getValue;
            SettingsStore.getValue = (name: SettingKey, roomId: string | null = null, excludeDefault = false): any => {
                switch (name) {
                    case "fontSizeDelta":
                        return 4;
                    case "useSystemFont":
                        return true;
                    case "systemFont":
                        return "OpenDyslexic, DejaVu Sans";
                    default:
                        return excludeDefault
                            ? originalGetValue(name, roomId, excludeDefault)
                            : originalGetValue(name, roomId, excludeDefault);
                }
            };
            document.documentElement.style.fontSize = "12px";

            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("fontScale")).toBe("1.5");
            expect(urlParams.getAll("font")).toEqual(["OpenDyslexic", "DejaVu Sans"]);

            SettingsStore.getValue = originalGetValue;
        });

        describe("Echo cancellation & Noise Suppression", () => {
            it("passes echo cancellation settings through widget URL if needed", async () => {
                const originalGetValue = SettingsStore.getValue;
                SettingsStore.getValue = (
                    name: SettingKey,
                    roomId: string | null = null,
                    excludeDefault = false,
                ): any => {
                    switch (name) {
                        case "webrtc_audio_echoCancellation":
                            return false;
                    }
                };
                ElementCall.create(room);
                const call = Call.get(room);
                if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

                const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
                expect(urlParams.get("echoCancellation")).toBe("false");

                SettingsStore.getValue = originalGetValue;
            });

            it("does not pass echo cancellation settings through widget URL if not needed", async () => {
                const originalGetValue = SettingsStore.getValue;
                SettingsStore.getValue = (
                    name: SettingKey,
                    roomId: string | null = null,
                    excludeDefault = false,
                ): any => {
                    switch (name) {
                        case "webrtc_audio_echoCancellation":
                            return true;
                    }
                };
                ElementCall.create(room);
                const call = Call.get(room);
                if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

                const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
                expect(urlParams.get("echoCancellation")).toBeNull();

                SettingsStore.getValue = originalGetValue;
            });

            it("passes noise suppression settings through widget URL if needed", async () => {
                const originalGetValue = SettingsStore.getValue;
                SettingsStore.getValue = (
                    name: SettingKey,
                    roomId: string | null = null,
                    excludeDefault = false,
                ): any => {
                    switch (name) {
                        case "webrtc_audio_noiseSuppression":
                            return false;
                    }
                };
                ElementCall.create(room);
                const call = Call.get(room);
                if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

                const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
                expect(urlParams.get("noiseSuppression")).toBe("false");

                SettingsStore.getValue = originalGetValue;
            });

            it("does not pass noise suppression settings through widget URL if not needed", async () => {
                const originalGetValue = SettingsStore.getValue;
                SettingsStore.getValue = (
                    name: SettingKey,
                    roomId: string | null = null,
                    excludeDefault = false,
                ): any => {
                    switch (name) {
                        case "webrtc_audio_noiseSuppression":
                            return true;
                    }
                };
                ElementCall.create(room);
                const call = Call.get(room);
                if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

                const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
                expect(urlParams.get("noiseSuppression")).toBeNull();

                SettingsStore.getValue = originalGetValue;
            });
        });

        it("passes ICE fallback preference through widget URL", async () => {
            // Test with the preference set to false
            ElementCall.create(room);
            const call1 = Call.get(room);
            if (!(call1 instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams1 = new URLSearchParams(new URL(call1.widget.url).hash.slice(1));
            expect(urlParams1.has("allowIceFallback")).toBe(false);
            call1.destroy();

            // Now test with the preference set to true
            const originalGetValue = SettingsStore.getValue;
            SettingsStore.getValue = (name: SettingKey, roomId: string | null = null, excludeDefault = false): any => {
                switch (name) {
                    case "fallbackICEServerAllowed":
                        return true;
                    default:
                        return excludeDefault
                            ? originalGetValue(name, roomId, excludeDefault)
                            : originalGetValue(name, roomId, excludeDefault);
                }
            };

            ElementCall.create(room);
            const call2 = Call.get(room);
            if (!(call2 instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams2 = new URLSearchParams(new URL(call2.widget.url).hash.slice(1));
            expect(urlParams2.has("allowIceFallback")).toBe(true);

            SettingsStore.getValue = originalGetValue;
        });

        it.each([
            [undefined, null],
            [BugReportEndpointURLLocal, null],
            ["other-value", "other-value"],
        ])("passes rageshake URL through widget URL", async (configSetting, expectedValue) => {
            // Test with the preference set to false
            SdkConfig.put({
                bug_report_endpoint_url: configSetting,
            });
            ElementCall.create(room);
            const call1 = Call.get(room);
            if (!(call1 instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams1 = new URLSearchParams(new URL(call1.widget.url).hash.slice(1));
            expect(urlParams1.get("rageshakeSubmitUrl")).toBe(expectedValue);
            call1.destroy();
        });

        it("passes analyticsID and posthog params through widget URL", async () => {
            SdkConfig.put({
                posthog: {
                    api_host: "https://posthog",
                    project_api_key: "DEADBEEF",
                },
            });
            jest.spyOn(PosthogAnalytics.instance, "getAnonymity").mockReturnValue(Anonymity.Pseudonymous);
            client.getAccountData.mockImplementation((eventType: string) => {
                if (eventType === PosthogAnalytics.ANALYTICS_EVENT_TYPE) {
                    return new MatrixEvent({ content: { id: "123456789987654321", pseudonymousAnalyticsOptIn: true } });
                }
                return undefined;
            });
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("posthogUserId")).toBe("123456789987654321");
            expect(urlParams.get("posthogApiHost")).toBe("https://posthog");
            expect(urlParams.get("posthogApiKey")).toBe("DEADBEEF");
        });

        it("does not pass analyticsID if `pseudonymousAnalyticsOptIn` set to false", async () => {
            client.getAccountData.mockImplementation((eventType: string) => {
                if (eventType === PosthogAnalytics.ANALYTICS_EVENT_TYPE) {
                    return new MatrixEvent({
                        content: { id: "123456789987654321", pseudonymousAnalyticsOptIn: false },
                    });
                }
                return undefined;
            });
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("analyticsID")).toBeFalsy();
        });

        it("passes empty analyticsID if the id is not in the account data", async () => {
            client.getAccountData.mockImplementation((eventType: string) => {
                if (eventType === PosthogAnalytics.ANALYTICS_EVENT_TYPE) {
                    return new MatrixEvent({ content: {} });
                }
                return undefined;
            });
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("analyticsID")).toBeFalsy();
        });

        it("requests correct intent in DMs", async () => {
            getUserIdForRoomIdSpy.mockImplementation((roomId: string) =>
                room.roomId === roomId ? "any-user" : undefined,
            );
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("intent")).toBe(ElementCallIntent.StartCallDM);
        });

        it("requests correct intent when answering DMs", async () => {
            roomSession.getOldestMembership.mockReturnValue({} as CallMembership);
            getUserIdForRoomIdSpy.mockImplementation((roomId: string) =>
                room.roomId === roomId ? "any-user" : undefined,
            );
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("intent")).toBe(ElementCallIntent.JoinExistingDM);
        });

        it("requests correct intent when creating a non-DM call", async () => {
            roomSession.getOldestMembership.mockReturnValue(undefined);
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("intent")).toBe(ElementCallIntent.StartCall);
        });

        it("requests correct intent when joining a non-DM call", async () => {
            roomSession.getOldestMembership.mockReturnValue({} as CallMembership);
            ElementCall.create(room);
            const call = Call.get(room);
            if (!(call instanceof ElementCall)) throw new Error("Failed to create call");

            const urlParams = new URLSearchParams(new URL(call.widget.url).hash.slice(1));
            expect(urlParams.get("intent")).toBe(ElementCallIntent.JoinExisting);
        });
    });

    describe("instance in a non-video room", () => {
        let call: ElementCall;
        let widget: Widget;
        let messaging: Mocked<WidgetMessaging>;
        let widgetApi: Mocked<ClientWidgetApi>;

        beforeEach(async () => {
            jest.useFakeTimers();
            jest.setSystemTime(0);

            ElementCall.create(room);
            const maybeCall = ElementCall.get(room);
            if (maybeCall === null) throw new Error("Failed to create call");
            call = maybeCall;

            ({ widget, messaging, widgetApi } = setUpWidget(call));
        });

        afterEach(() => cleanUpCallAndWidget(call, widget));

        describe("initial device state", () => {
            let originalGetValue: typeof SettingsStore.getValue;
            let overrides: Partial<Record<SettingKey, boolean>>;

            const emitDeviceMuteReport = (data: { audio_enabled: boolean; video_enabled: boolean }): void => {
                widgetApi.emit(`action:${ElementWidgetActions.DeviceMute}`, {
                    preventDefault: jest.fn(),
                    detail: { data },
                });
            };

            beforeEach(() => {
                overrides = {};
                originalGetValue = SettingsStore.getValue;
                SettingsStore.getValue = ((name: SettingKey, ...rest: any[]): any =>
                    name in overrides
                        ? overrides[name]
                        : (originalGetValue as any)(name, ...rest)) as typeof SettingsStore.getValue;
            });

            afterEach(() => {
                SettingsStore.getValue = originalGetValue;
            });

            it("joins with the mic the left panel has switched on, and the camera off", async () => {
                await call.start({});

                expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.DeviceMute, {
                    audio_enabled: true,
                    video_enabled: false,
                });
            });

            it("joins muted when the left panel's mic toggle is off", async () => {
                overrides["audioInputMuted"] = true;

                await call.start({});

                expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.DeviceMute, {
                    audio_enabled: false,
                    video_enabled: false,
                });
            });

            it("never joins with the camera on, whatever the stored default says", async () => {
                overrides["videoInputMuted"] = false;

                await call.start({});

                expect(widgetApi.transport.send).toHaveBeenCalledWith(
                    ElementWidgetActions.DeviceMute,
                    expect.objectContaining({ video_enabled: false }),
                );
            });

            it("asks again when the widget reports it came up in another state", async () => {
                overrides["audioInputMuted"] = true;
                await call.start({});
                mocked(widgetApi.transport).send.mockClear();

                // Element Call ignores the request until it has enumerated its
                // devices, and only then says what it settled on
                emitDeviceMuteReport({ audio_enabled: true, video_enabled: false });

                expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.DeviceMute, {
                    audio_enabled: false,
                    video_enabled: false,
                });
            });

            it("stops asking once the widget confirms the state", async () => {
                overrides["audioInputMuted"] = true;
                mocked(widgetApi.transport).send.mockResolvedValue({ audio_enabled: false, video_enabled: false });
                // Connected, not merely started: the point of this test is what
                // happens *within* a call, and out of one a change in the lobby
                // is now adopted as the join default instead.
                await connect(call, widgetApi);
                await jest.advanceTimersByTimeAsync(0);
                mocked(widgetApi.transport).send.mockClear();

                // The user unmuting from within the call is theirs to decide, and
                // must not be undone by the left panel's toggle
                emitDeviceMuteReport({ audio_enabled: true, video_enabled: false });

                expect(widgetApi.transport.send).not.toHaveBeenCalled();
            });

            it("pushes a default that changes while the user waits in the lobby", async () => {
                await call.start({});
                await jest.advanceTimersByTimeAsync(0);
                mocked(widgetApi.transport).send.mockClear();

                // The panel's mic toggle gets flipped while the lobby is up. It
                // used to be read only when the widget started, so the change
                // did nothing until the room was left and reopened.
                overrides["audioInputMuted"] = true;
                await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, true);
                await jest.advanceTimersByTimeAsync(0);

                expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.DeviceMute, {
                    audio_enabled: false,
                    video_enabled: false,
                });
            });

            it("picks up a default change before it has ever been started", async () => {
                // Opening the room directly leaves RoomViewStore to fire start()
                // off unawaited, so the toggles cannot depend on it having landed
                // - this used to do nothing until the room was reselected.
                overrides["audioInputMuted"] = true;
                await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, true);
                await jest.advanceTimersByTimeAsync(0);

                await call.start({});

                expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.DeviceMute, {
                    audio_enabled: false,
                    video_enabled: false,
                });
            });

            /*
             * `getValue` is stubbed from `overrides` here, so reading a value
             * back after a write would just report the old one. These assert the
             * write itself instead.
             */
            const micDefaultWrites = (setValue: jest.SpyInstance): unknown[] =>
                setValue.mock.calls.filter(([name]) => name === "audioInputMuted");

            it("takes the mic back off the lobby, so the panel agrees with it", async () => {
                overrides["audioInputMuted"] = false; // Joining unmuted
                const setValue = jest.spyOn(SettingsStore, "setValue");
                // Let the widget confirm, so nothing is pending any more
                mocked(widgetApi.transport).send.mockResolvedValue({ audio_enabled: true, video_enabled: false });
                await call.start({});
                await jest.advanceTimersByTimeAsync(10);
                setValue.mockClear();

                // The user mutes in Element Call's own lobby. The panel shows the
                // join default out of a call, so without this it would carry on
                // claiming the mic was on.
                emitDeviceMuteReport({ audio_enabled: false, video_enabled: false });
                await jest.advanceTimersByTimeAsync(10);

                expect(setValue).toHaveBeenCalledWith("audioInputMuted", null, SettingLevel.DEVICE, true);
            });

            it("does not tell the widget something it just told us", async () => {
                overrides["audioInputMuted"] = false;
                await call.start({});
                await jest.advanceTimersByTimeAsync(10);
                emitDeviceMuteReport({ audio_enabled: true, video_enabled: false }); // The widget agrees
                mocked(widgetApi.transport).send.mockClear();

                // A default that matches what the widget already reports has
                // nothing to push, or the two take turns forever.
                await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, false);
                await jest.advanceTimersByTimeAsync(10);

                expect(widgetApi.transport.send).not.toHaveBeenCalled();
            });

            it("keeps Element Call's own starting state out of the stored default", async () => {
                overrides["audioInputMuted"] = true; // The user joins muted
                const setValue = jest.spyOn(SettingsStore, "setValue");

                await call.start({});
                setValue.mockClear();
                // Element Call comes up unmuted and says so before it has taken
                // any notice of us. Adopting that would silently undo the user's
                // choice every time they opened a room.
                emitDeviceMuteReport({ audio_enabled: true, video_enabled: false });
                await jest.advanceTimersByTimeAsync(10);

                expect(micDefaultWrites(setValue)).toEqual([]);
            });

            it("leaves the default alone once in the call", async () => {
                overrides["audioInputMuted"] = false;
                const setValue = jest.spyOn(SettingsStore, "setValue");
                await connect(call, widgetApi);
                await jest.advanceTimersByTimeAsync(10);
                setValue.mockClear();

                // Muting within a call is about that call, not about how the
                // next one starts.
                emitDeviceMuteReport({ audio_enabled: false, video_enabled: false });
                await jest.advanceTimersByTimeAsync(10);

                expect(micDefaultWrites(setValue)).toEqual([]);
            });

            it("leaves a running call alone when the default changes", async () => {
                await connect(call, widgetApi);
                await jest.advanceTimersByTimeAsync(0);
                mocked(widgetApi.transport).send.mockClear();

                overrides["audioInputMuted"] = true;
                await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, true);
                await jest.advanceTimersByTimeAsync(0);

                // In a call the toggle is the call's own mute, driven straight
                // from the panel - a default has nothing left to say about it.
                expect(widgetApi.transport.send).not.toHaveBeenCalledWith(
                    ElementWidgetActions.DeviceMute,
                    expect.anything(),
                );
            });

            it("drives its widget even though nothing ever started it", () => {
                // On the room the app opens with, nothing gets as far as
                // start(): the room is not in the client's store when
                // RoomViewStore first looks, and by the time it is, that room is
                // "the same room" and the question is not asked again. The widget
                // still renders, and Element Call then talks to a host with
                // nothing listening - its join and mute actions come back
                // "unknown or unsupported from-widget action". Note this test
                // never calls start(): the widget's messaging alone is the cue.
                emitDeviceMuteReport({ audio_enabled: false, video_enabled: true });
                expect(call.deviceMuteState).toEqual({ audio_enabled: false, video_enabled: true });

                widgetApi.emit(`action:${ElementWidgetActions.JoinCall}`, new CustomEvent("widgetapirequest", {}));
                expect(call.connectionState).toBe(ConnectionState.Connected);
            });

            it("follows the widget when it is rebuilt underneath us", async () => {
                await call.start({});
                await jest.advanceTimersByTimeAsync(0);

                // React strict mode, a container move or a remount all replace
                // the messaging. The handle start() took is dead from here on.
                const { widgetApi: rebuilt } = setUpWidget(call);
                await jest.advanceTimersByTimeAsync(0);
                mocked(rebuilt.transport).send.mockClear();

                // The call's own mic button has to keep reaching the panel...
                rebuilt.emit(
                    `action:${ElementWidgetActions.DeviceMute}`,
                    new CustomEvent("widgetapirequest", {
                        detail: { data: { audio_enabled: false, video_enabled: true } },
                    }),
                );
                expect(call.deviceMuteState).toEqual({ audio_enabled: false, video_enabled: true });

                // ...and joining from the new widget has to still reach us
                rebuilt.emit(`action:${ElementWidgetActions.JoinCall}`, new CustomEvent("widgetapirequest", {}));
                expect(call.connectionState).toBe(ConnectionState.Connected);
            });

            it("reports the state the widget settled on, so the panel can show it", async () => {
                await call.start({});
                await jest.advanceTimersByTimeAsync(0);

                emitDeviceMuteReport({ audio_enabled: false, video_enabled: true });

                expect(call.deviceMuteState).toEqual({ audio_enabled: false, video_enabled: true });
            });

            it("changes the devices of a call that is already running", async () => {
                await call.start({});
                await jest.advanceTimersByTimeAsync(0);
                mocked(widgetApi.transport).send.mockClear();
                mocked(widgetApi.transport).send.mockResolvedValue({ audio_enabled: true, video_enabled: true });

                await call.setDeviceMute({ video_enabled: true });

                // Only the field that was asked for: leaving the other out is how
                // the widget is told to keep it as it is.
                expect(widgetApi.transport.send).toHaveBeenCalledWith(ElementWidgetActions.DeviceMute, {
                    video_enabled: true,
                });
                expect(call.deviceMuteState).toEqual({ audio_enabled: true, video_enabled: true });
            });
        });

        it("waits for messaging when starting (widget API available immediately)", async () => {
            // Temporarily remove the messaging to simulate connecting while the
            // widget is still initializing
            WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            const startup = call.start({});
            WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, messaging);
            await startup;
            await connect(call, widgetApi, false);
            expect(call.connectionState).toBe(ConnectionState.Connected);
        });

        it("waits for messaging when starting (widget API started asynchronously)", async () => {
            // Temporarily remove the messaging to simulate connecting while the
            // widget is still initializing
            WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
            // Also remove the widget API from said messaging until later
            let storedWidgetApi: Mocked<ClientWidgetApi> | null = null;
            Object.defineProperty(messaging, "widgetApi", {
                get() {
                    return storedWidgetApi;
                },
            });
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            const startup = call.start({});
            WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, messaging);
            // Yield the event loop to the Call.start promise, then simulate the
            // widget API being started asynchronously
            await Promise.resolve();
            storedWidgetApi = widgetApi;
            messaging.emit(WidgetMessagingEvent.Start, storedWidgetApi);
            await startup;
            await connect(call, widgetApi, false);
            expect(call.connectionState).toBe(ConnectionState.Connected);
        });

        it("waits for messaging when starting (even if messaging is replaced during startup)", async () => {
            const firstMessaging = messaging;
            // Entirely remove the widget API from this first messaging
            Object.defineProperty(firstMessaging, "widgetApi", {
                get() {
                    return null;
                },
            });
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            const startup = call.start({});
            // Now imagine that the messaging gets abandoned and replaced by an
            // entirely new messaging object
            ({ widget, messaging, widgetApi } = setUpWidget(call));
            WidgetMessagingStore.instance.storeMessaging(widget, room.roomId, messaging);
            await startup;
            await connect(call, widgetApi, false);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            expect(firstMessaging.listenerCount(WidgetMessagingEvent.Start)).toBe(0); // No leaks
        });

        it("disconnects anyway if the widget returns an error", async () => {
            await connect(call, widgetApi);
            mocked(widgetApi.transport).send.mockRejectedValue(new Error("never!!1! >:("));

            await expect(call.disconnect()).resolves.toBeUndefined();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("disconnects even though Element Call never sends a hangup back", async () => {
            await connect(call, widgetApi);
            // Element Call acks the request and says nothing further - the
            // behaviour the old code waited forever for.
            mocked(widgetApi.transport).send.mockResolvedValue({});

            await expect(call.disconnect()).resolves.toBeUndefined();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("ends the call locally when the widget never answers at all", async () => {
            await connect(call, widgetApi);
            mocked(widgetApi.transport).send.mockReturnValue(new Promise(() => {})); // Never settles
            // The unanswered request would otherwise be replayed into the next
            // call in this widget, so the widget itself has to go
            const destroyWidget = jest.spyOn(ActiveWidgetStore.instance, "destroyPersistentWidget");

            const disconnection = call.disconnect();
            await jest.advanceTimersByTimeAsync(5000);

            await expect(disconnection).resolves.toBeUndefined();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            expect(destroyWidget).toHaveBeenCalled();
        });

        it("leaves the widget alone when the hangup is acknowledged", async () => {
            await connect(call, widgetApi);
            mocked(widgetApi.transport).send.mockResolvedValue({});
            const destroyWidget = jest.spyOn(ActiveWidgetStore.instance, "destroyPersistentWidget");

            await call.disconnect();

            expect(destroyWidget).not.toHaveBeenCalled();
        });

        it("does nothing when disconnecting a call that is already disconnected", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await expect(call.disconnect()).resolves.toBeUndefined();
            expect(widgetApi.transport.send).not.toHaveBeenCalledWith(ElementWidgetActions.HangupCall, {});
        });

        it("handles remote disconnection", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);

            widgetApi.emit(`action:${ElementWidgetActions.HangupCall}`, new CustomEvent("widgetapirequest", {}));
            widgetApi.emit(`action:${ElementWidgetActions.Close}`, new CustomEvent("widgetapirequest", {}));
            await waitFor(() => expect(call.connectionState).toBe(ConnectionState.Disconnected), { interval: 5 });
        });

        it("disconnects", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            await disconnect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("disconnects when we leave the room", async () => {
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            room.emit(RoomEvent.MyMembership, room, KnownMembership.Leave);
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("remains connected if we stay in the room", async () => {
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            room.emit(RoomEvent.MyMembership, room, KnownMembership.Join);
            expect(call.connectionState).toBe(ConnectionState.Connected);
        });

        it("disconnects if the widget dies", async () => {
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);
            WidgetMessagingStore.instance.stopMessaging(widget, room.roomId);
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
        });

        it("keeps the widget on screen for as long as we are connected", async () => {
            expect(ActiveWidgetStore.instance.getWidgetPersistence(call.widget.id, room.roomId)).toBe(false);

            // Being connected is what keeps the widget alive while it moves
            // between the room view and the picture-in-picture container, so we
            // must not wait for the widget to ask for it: changing room in the
            // meantime would leave it with no container and kill the call.
            await connect(call, widgetApi);
            expect(ActiveWidgetStore.instance.getWidgetPersistence(call.widget.id, room.roomId)).toBe(true);

            await disconnect(call, widgetApi);
            expect(ActiveWidgetStore.instance.getWidgetPersistence(call.widget.id, room.roomId)).toBe(false);
        });

        it("stops counting as an active call before releasing the widget", async () => {
            await connect(call, widgetApi);

            // Whoever tears down the last container asks whether a call still
            // needs the widget, and is woken by the persistence change. If the
            // call still looked connected at that point the widget would be
            // left running with nothing on screen.
            let connectedWhenReleased: boolean | undefined;
            ActiveWidgetStore.instance.once(ActiveWidgetStoreEvent.Persistence, () => {
                connectedWhenReleased = call.connected;
            });
            await disconnect(call, widgetApi);

            expect(connectedWhenReleased).toBe(false);
        });

        it("acknowledges mute_device widget action", async () => {
            await connect(call, widgetApi);
            const preventDefault = jest.fn();
            const mockEv = {
                preventDefault,
                detail: { video_enabled: false },
            };
            widgetApi.emit(`action:${ElementWidgetActions.DeviceMute}`, mockEv);
            expect(widgetApi.transport.reply).toHaveBeenCalledWith({ video_enabled: false }, {});
            expect(preventDefault).toHaveBeenCalled();
        });

        it("emits events when connection state changes", async () => {
            // const wait = jest.spyOn(CallModule, "waitForEvent");
            const onConnectionState = jest.fn();
            call.on(CallEvent.ConnectionState, onConnectionState);

            await connect(call, widgetApi);
            await disconnect(call, widgetApi);
            expect(onConnectionState.mock.calls).toEqual([
                [ConnectionState.Connected, ConnectionState.Disconnected],
                [ConnectionState.Disconnecting, ConnectionState.Connected],
                [ConnectionState.Disconnected, ConnectionState.Disconnecting],
            ]);

            call.off(CallEvent.ConnectionState, onConnectionState);
        });

        it("emits events when participants change", async () => {
            const onParticipants = jest.fn();
            call.session.memberships = [{ sender: alice.userId, deviceId: "alices_device" } as CallMembership];
            call.on(CallEvent.Participants, onParticipants);
            call.session.emit(MatrixRTCSessionEvent.MembershipsChanged, [], []);

            expect(onParticipants.mock.calls).toEqual([[new Map([[alice, new Set(["alices_device"])]]), new Map()]]);

            call.off(CallEvent.Participants, onParticipants);
        });

        it("emits events when call type changes", async () => {
            const onCallTypeChanged = jest.fn();
            call.on(CallEvent.CallTypeChanged, onCallTypeChanged);
            // Should default to video when unknown
            expect(call.callType).toBe(CallType.Video);

            // Change call type to voice
            roomSession.memberships = [
                { sender: alice.userId, deviceId: "alices_device", callIntent: "audio" } as Mocked<CallMembership>,
            ];
            roomSession.getConsensusCallIntent.mockReturnValue("audio");
            roomSession.emit(MatrixRTCSessionEvent.MembershipsChanged, [], []);

            expect(call.callType).toBe(CallType.Voice);
            expect(onCallTypeChanged.mock.calls).toEqual([[CallType.Voice]]);

            // Change call type back to video
            roomSession.memberships = [
                { sender: alice.userId, deviceId: "alices_device", callIntent: "video" } as Mocked<CallMembership>,
            ];
            roomSession.getConsensusCallIntent.mockReturnValue("video");
            roomSession.emit(MatrixRTCSessionEvent.MembershipsChanged, [], []);

            expect(call.callType).toBe(CallType.Video);
            expect(onCallTypeChanged.mock.calls).toEqual([[CallType.Voice], [CallType.Video]]);

            call.off(CallEvent.CallTypeChanged, onCallTypeChanged);
        });

        it("ends the call immediately if the session ended", async () => {
            await connect(call, widgetApi);
            const onDestroy = jest.fn();
            call.on(CallEvent.Destroy, onDestroy);
            await disconnect(call, widgetApi);
            // this will be called automatically
            // disconnect -> widget sends state event -> session manager notices no-one left
            client.matrixRTC.emit(
                MatrixRTCSessionManagerEvents.SessionEnded,
                room.roomId,
                {} as unknown as MatrixRTCSession,
            );
            expect(onDestroy).toHaveBeenCalled();
            call.off(CallEvent.Destroy, onDestroy);
        });

        it("clears widget persistence when destroyed", async () => {
            const destroyPersistentWidgetSpy = jest.spyOn(ActiveWidgetStore.instance, "destroyPersistentWidget");
            call.destroy();
            expect(destroyPersistentWidgetSpy).toHaveBeenCalled();
        });

        it("the perParticipantE2EE url flag is used in encrypted rooms while respecting the feature_disable_call_per_sender_encryption flag", async () => {
            // We destroy the call created in beforeEach because we test the call creation process.
            call.destroy();
            const addWidgetSpy = jest.spyOn(WidgetStore.instance, "addVirtualWidget");
            // If a room is not encrypted we will never add the perParticipantE2EE flag.
            const roomSpy = jest.spyOn(room, "hasEncryptionStateEvent").mockReturnValue(true);

            // should create call with perParticipantE2EE flag
            ElementCall.create(room);
            expect(Call.get(room)?.widget?.data?.perParticipantE2EE).toBe(true);

            // should create call without perParticipantE2EE flag
            enabledSettings.add("feature_disable_call_per_sender_encryption");
            expect(Call.get(room)?.widget?.data?.perParticipantE2EE).toBe(false);
            enabledSettings.delete("feature_disable_call_per_sender_encryption");
            roomSpy.mockRestore();
            addWidgetSpy.mockRestore();
        });
    });

    describe("instance in a video room", () => {
        let call: ElementCall;
        let widget: Widget;
        let widgetApi: Mocked<ClientWidgetApi>;

        beforeEach(async () => {
            jest.useFakeTimers();
            jest.setSystemTime(0);

            jest.spyOn(room, "getType").mockReturnValue(RoomType.UnstableCall);

            ElementCall.create(room);
            const maybeCall = ElementCall.get(room);
            if (maybeCall === null) throw new Error("Failed to create call");
            call = maybeCall;

            ({ widget, widgetApi } = setUpWidget(call));
        });

        afterEach(() => cleanUpCallAndWidget(call, widget));

        it("doesn't end the call when the last participant leaves", async () => {
            await connect(call, widgetApi);
            const onDestroy = jest.fn();
            call.on(CallEvent.Destroy, onDestroy);
            await disconnect(call, widgetApi);
            expect(onDestroy).not.toHaveBeenCalled();
            call.off(CallEvent.Destroy, onDestroy);
        });

        it("can be rejoined from the lobby after hanging up locally", async () => {
            await connect(call, widgetApi);
            mocked(widgetApi.transport).send.mockResolvedValue({});

            await call.disconnect();
            expect(call.connectionState).toBe(ConnectionState.Disconnected);

            // The widget is still there, showing its lobby, so the join it sends
            // when the user goes back in has to still reach us. Closing our side
            // on hangup took that listener away, and the call then ran with
            // nothing in the UI knowing about it.
            widgetApi.emit(`action:${ElementWidgetActions.JoinCall}`, new CustomEvent("widgetapirequest", {}));
            await waitFor(() => expect(call.connectionState).toBe(ConnectionState.Connected), { interval: 5 });
        });

        it("handles remote disconnection and reconnect right after", async () => {
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await connect(call, widgetApi);
            expect(call.connectionState).toBe(ConnectionState.Connected);

            widgetApi.emit(`action:${ElementWidgetActions.HangupCall}`, new CustomEvent("widgetapirequest", {}));
            // We should now be able to reconnect without manually starting the widget
            expect(call.connectionState).toBe(ConnectionState.Disconnected);
            await connect(call, widgetApi, false);
            await waitFor(() => expect(call.connectionState).toBe(ConnectionState.Connected), { interval: 5 });
        });
    });
    describe("create call", () => {
        beforeEach(async () => {
            setRoomMembers(["@user:example.com", "@user2:example.com", "@user4:example.com"]);
        });
        it("don't sent notify event if there are existing room call members", async () => {
            jest.spyOn(MatrixRTCSession, "sessionMembershipsForSlot").mockResolvedValue([
                { application: "m.call", callId: "" } as unknown as CallMembership,
            ]);
            const sendEventSpy = jest.spyOn(room.client, "sendEvent");
            ElementCall.create(room);
            expect(sendEventSpy).not.toHaveBeenCalled();
        });
    });
});
