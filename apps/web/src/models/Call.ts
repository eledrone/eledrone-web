/*
Copyright 2024 New Vector Ltd.
Copyright 2022 The Matrix.org Foundation C.I.C.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import {
    TypedEventEmitter,
    EventType,
    RoomEvent,
    RoomStateEvent,
    type MatrixClient,
    type IMyDevice,
    type Room,
    type RoomMember,
} from "matrix-js-sdk/src/matrix";
import { KnownMembership, type Membership } from "matrix-js-sdk/src/types";
import { logger as rootLogger } from "matrix-js-sdk/src/logger";
import { secureRandomString } from "matrix-js-sdk/src/randomstring";
import { CallType } from "matrix-js-sdk/src/webrtc/call";
import { type IWidgetApiRequest, type ClientWidgetApi, type IWidgetData } from "matrix-widget-api";
import {
    type MatrixRTCSession,
    MatrixRTCSessionEvent,
    MatrixRTCSessionManagerEvents,
} from "matrix-js-sdk/src/matrixrtc";

// oxlint-disable-next-line no-restricted-imports
import type EventEmitter from "events";
import type { IApp } from "../stores/WidgetStore";
import SettingsStore from "../settings/SettingsStore";
import { timeout } from "../utils/promise";
import WidgetUtils from "../utils/WidgetUtils";
import { WidgetType } from "../widgets/WidgetType";
import { ElementWidgetActions } from "../stores/widgets/ElementWidgetActions";
import WidgetStore from "../stores/WidgetStore";
import { WidgetMessagingStore, WidgetMessagingStoreEvent } from "../stores/widgets/WidgetMessagingStore";
import ActiveWidgetStore, { ActiveWidgetStoreEvent } from "../stores/ActiveWidgetStore";
import { getCurrentLanguage } from "../languageHandler";
import { Anonymity, PosthogAnalytics } from "../PosthogAnalytics";
import { isVideoRoom } from "../utils/video-rooms";
import { FontWatcher } from "../settings/watchers/FontWatcher";
import { type JitsiCallMemberContent, JitsiCallMemberEventType } from "../call-types";
import SdkConfig from "../SdkConfig.ts";
import DMRoomMap from "../utils/DMRoomMap.ts";
import { type WidgetMessaging, WidgetMessagingEvent } from "../stores/widgets/WidgetMessaging.ts";
import { BugReportEndpointURLLocal } from "../IConfigOptions.ts";
import {
    type DeviceMuteState,
    getDefaultDeviceMuteState,
    isCallDeviceEnabledByDefault,
    setCallDeviceEnabledByDefault,
} from "../utils/call-device-defaults.ts";

const TIMEOUT_MS = 16000;

/**
 * How long to wait for the widget to acknowledge a hangup before giving up and
 * ending the call locally anyway. Deliberately under the widget API transport's
 * own 10s timeout, so the user is never left staring at a call they have left
 * while a dead widget is waited on.
 */
const DISCONNECT_TIMEOUT_MS = 4000;

/**
 * Rejects if the given promise has not settled within `ms`.
 *
 * Not `utils/promise`'s `timeout`, which attaches a bare `.then` to the promise
 * it is given: the promise that creates rejects along with it and has nothing
 * listening, which takes the whole process down. Everything that reaches for a
 * timeout here can fail, so it needs one that coped with that.
 */
const rejectAfter = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
    let timeoutId: number | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
};

/**
 * How long our own RTC membership may be missing from a call we believe we are
 * in before we conclude that we have left it. Long enough to ride out the gap a
 * reconnection leaves, short enough that the panel does not linger.
 */
const OWN_MEMBERSHIP_GRACE_MS = 3000;

/**
 * How long a sticky membership event lives for. Mirrors the js-sdk's own
 * MEMBERSHIP_STICKY_DURATION_MS, which it does not export; a retraction has to
 * be sent with the same duration as the membership it replaces.
 */
const MEMBERSHIP_STICKY_DURATION_MS = 60 * 60 * 1000;

const logger = rootLogger.getChild("models/Call");

// Whether a widget's reported mic and camera state is the one we asked it for.
const deviceMuteStateMatches = (reported: DeviceMuteState | undefined, desired: Required<DeviceMuteState>): boolean =>
    reported?.audio_enabled === desired.audio_enabled && reported?.video_enabled === desired.video_enabled;

// Waits until an event is emitted satisfying the given predicate
const waitForEvent = async (
    emitter: EventEmitter,
    event: string,
    pred: (...args: any[]) => boolean = () => true,
    customTimeout?: number | false,
): Promise<void> => {
    let listener: (...args: any[]) => void;
    const wait = new Promise<void>((resolve) => {
        listener = (...args) => {
            if (pred(...args)) resolve();
        };
        emitter.on(event, listener);
    });

    if (customTimeout !== false) {
        const timedOut = (await timeout(wait, false, customTimeout ?? TIMEOUT_MS)) === false;
        if (timedOut) throw new Error("Timed out");
    } else {
        await wait;
    }
    emitter.off(event, listener!);
};

export enum ConnectionState {
    Disconnected = "disconnected",
    Connected = "connected",
    Disconnecting = "disconnecting",
}

export const isConnected = (state: ConnectionState): boolean =>
    state === ConnectionState.Connected || state === ConnectionState.Disconnecting;

export enum CallEvent {
    ConnectionState = "connection_state",
    Participants = "participants",
    Close = "close",
    Destroy = "destroy",
    CallTypeChanged = "call_type_changed",
    // The mic and camera state the widget reports it is in. Only ElementCall
    // emits this; it is what lets the left panel show and drive a running call.
    DeviceMuteState = "device_mute_state",
}

interface CallEventHandlerMap {
    [CallEvent.ConnectionState]: (state: ConnectionState, prevState: ConnectionState) => void;
    [CallEvent.Participants]: (
        participants: Map<RoomMember, Set<string>>,
        prevParticipants: Map<RoomMember, Set<string>>,
    ) => void;
    [CallEvent.Close]: () => void;
    [CallEvent.Destroy]: () => void;
    [CallEvent.CallTypeChanged]: (callType: CallType) => void;
    [CallEvent.DeviceMuteState]: (state: Required<DeviceMuteState>) => void;
}

/**
 * A group call accessed through a widget.
 */
export abstract class Call extends TypedEventEmitter<CallEvent, CallEventHandlerMap> {
    protected readonly widgetUid: string;
    protected readonly room: Room;

    private _callType: CallType;
    public get callType(): CallType {
        return this._callType;
    }

    protected set callType(callType: CallType) {
        const prevCallType = this._callType;
        this._callType = callType;
        if (callType !== prevCallType) this.emit(CallEvent.CallTypeChanged, callType);
    }

    /**
     * The time after which device member state should be considered expired.
     */
    public abstract readonly STUCK_DEVICE_TIMEOUT_MS: number;

    private _widgetApi: ClientWidgetApi | null = null;
    /**
     * The widget API interface to the widget, or null if disconnected.
     */
    protected get widgetApi(): ClientWidgetApi | null {
        return this._widgetApi;
    }
    // Protected rather than private: a widget can be torn down and rebuilt under
    // us, and whoever notices has to be able to point us at the new one.
    protected set widgetApi(value: ClientWidgetApi | null) {
        this._widgetApi = value;
    }

    public get roomId(): string {
        return this.widget.roomId;
    }

    private _connectionState = ConnectionState.Disconnected;
    public get connectionState(): ConnectionState {
        return this._connectionState;
    }
    protected set connectionState(value: ConnectionState) {
        const prevValue = this._connectionState;
        this._connectionState = value;
        this.emit(CallEvent.ConnectionState, value, prevValue);
    }

    public get connected(): boolean {
        return isConnected(this.connectionState);
    }

    private _participants = new Map<RoomMember, Set<string>>();
    /**
     * The participants in the call, as a map from members to device IDs.
     */
    public get participants(): Map<RoomMember, Set<string>> {
        return this._participants;
    }
    protected set participants(value: Map<RoomMember, Set<string>>) {
        const prevValue = this._participants;
        this._participants = value;
        this.emit(CallEvent.Participants, value, prevValue);
    }

    private _presented = false;
    /**
     * Whether the call widget is currently being presented in the user interface.
     */
    public get presented(): boolean {
        return this._presented;
    }
    public set presented(value: boolean) {
        this._presented = value;
    }

    protected constructor(
        /**
         * The widget used to access this call.
         */
        public readonly widget: IApp,
        protected readonly client: MatrixClient,
        initialCallType: CallType,
    ) {
        super();
        this.widgetUid = WidgetUtils.getWidgetUid(this.widget);
        this.room = this.client.getRoom(this.roomId)!;
        WidgetMessagingStore.instance.on(WidgetMessagingStoreEvent.StopMessaging, this.onStopMessaging);
        this._callType = initialCallType;
    }

    /**
     * Gets the call associated with the given room, if any.
     * @param {Room} room The room.
     * @returns {Call | null} The call.
     */
    public static get(room: Room): Call | null {
        return ElementCall.get(room) ?? JitsiCall.get(room);
    }

    /**
     * Performs a routine check of the call's associated room state, cleaning up
     * any data left over from an unclean disconnection.
     */
    public abstract clean(): Promise<void>;

    /**
     * Contacts the widget to disconnect from the call.
     */
    protected abstract performDisconnection(): Promise<void>;

    /**
     * Starts the communication between the widget and the call.
     * The widget associated with the call must be active for this to succeed.
     * Only call this if the call state is: ConnectionState.Disconnected.
     * @param _params Widget generation parameters are unused in this abstract class.
     * @returns The ClientWidgetApi for this call.
     */
    public async start(_params?: WidgetGenerationParameters): Promise<ClientWidgetApi> {
        const messagingStore = WidgetMessagingStore.instance;
        const startTime = performance.now();
        let messaging: WidgetMessaging | undefined = messagingStore.getMessagingForUid(this.widgetUid);
        // The widget might still be initializing, so wait for it in an async
        // event loop. We need the messaging to be both present and started
        // (have a connected widget API), so register listeners for both cases.
        // oxlint-disable-next-line no-unmodified-loop-condition
        while (!messaging?.widgetApi) {
            if (messaging) logger.debug(`Messaging present but not yet started for ${this.widgetUid}`);
            else logger.debug(`No messaging yet for ${this.widgetUid}`);
            const recheck = Promise.withResolvers<void>();
            const currentMessaging = messaging;

            // Maybe the messaging is present but not yet started. In this case,
            // check again for a widget API as soon as it starts.
            const onStart = (): void => recheck.resolve();
            currentMessaging?.on(WidgetMessagingEvent.Start, onStart);

            // Maybe the messaging is not present at all. It's also entirely
            // possible (as shown in React strict mode) that the messaging could
            // be abandoned and replaced by an entirely new messaging object
            // while we were waiting for the original one to start. We need to
            // react to store updates in either case.
            const onStoreMessaging = (uid: string, m: WidgetMessaging): void => {
                if (uid === this.widgetUid) {
                    messagingStore.off(WidgetMessagingStoreEvent.StoreMessaging, onStoreMessaging);
                    messaging = m; // Check the new messaging object on the next iteration of the loop
                    recheck.resolve();
                }
            };
            messagingStore.on(WidgetMessagingStoreEvent.StoreMessaging, onStoreMessaging);

            // Race both of the above recheck signals against a timeout.
            const timeout = setTimeout(
                () => recheck.reject(new Error(`Widget for call in ${this.roomId} not started; timed out`)),
                TIMEOUT_MS - (performance.now() - startTime),
            );

            try {
                await recheck.promise;
            } finally {
                currentMessaging?.off(WidgetMessagingEvent.Start, onStart);
                messagingStore.off(WidgetMessagingStoreEvent.StoreMessaging, onStoreMessaging);
                clearTimeout(timeout);
            }
        }

        logger.debug(`Widget ${this.widgetUid} now ready`);
        return (this.widgetApi = messaging.widgetApi);
    }

    protected setConnected(): void {
        this.room.on(RoomEvent.MyMembership, this.onMyMembership);
        window.addEventListener("beforeunload", this.beforeUnload);
        // Claim persistence ourselves rather than waiting for the widget to ask
        // for it. The widget does send set_always_on_screen when it joins, but
        // that is a round trip we don't control the timing of, and persistence
        // is what keeps the widget alive while it moves between the room view
        // and the picture-in-picture container. Until it is set, changing room
        // unmounts the only container the widget has, which stops its messaging
        // and reads to us as the widget dying - i.e. a hangup the user never
        // asked for. See onStopMessaging below.
        ActiveWidgetStore.instance.setWidgetPersistence(this.widget.id, this.roomId, true);
        this.connectionState = ConnectionState.Connected;
    }

    /**
     * Manually marks the call as disconnected.
     */
    protected setDisconnected(): void {
        this.room.off(RoomEvent.MyMembership, this.onMyMembership);
        window.removeEventListener("beforeunload", this.beforeUnload);
        // Order matters: stop counting as an active call first, then release the
        // widget. Releasing it is what makes the UI drop the last container, and
        // whoever tears that container down asks whether a call still needs the
        // widget - by then, we don't, so it gets cleaned up rather than left
        // running with nothing on screen.
        this.connectionState = ConnectionState.Disconnected;
        // This is a no-op if some other widget has since taken the (single)
        // persistence slot, so it can't tear down anyone else.
        ActiveWidgetStore.instance.setWidgetPersistence(this.widget.id, this.roomId, false);
    }

    /**
     * Called when a disconnection got no answer out of the widget, after the
     * call has already been ended locally. A subclass whose widget can be left
     * in a bad state by that overrides this to tear it down.
     */
    protected cleanUpAfterUncleanDisconnection(): void {}

    /**
     * Whether hanging up should also stop talking to the widget.
     *
     * True for a call that is over when you leave it. A subclass whose widget
     * outlives the call - because the user is put back in a lobby they can
     * rejoin from - says no, since closing would drop the listeners that hear
     * that rejoin.
     */
    protected shouldCloseOnDisconnect(): boolean {
        return true;
    }

    /**
     * Disconnects the user from the call.
     *
     * Always ends the call locally, whatever the widget does. A widget that
     * never answers used to leave the call parked in Disconnecting - which
     * counts as connected - so the user was left in a call they had left, and
     * every other room refused to start one. Telling the widget is best effort;
     * our own state is not.
     */
    public async disconnect(): Promise<void> {
        // Idempotent rather than throwing: disconnect() is called across every
        // other connected call inside a Promise.all when joining a new one, and
        // a rejection there breaks the join.
        if (!this.connected) return;

        this.connectionState = ConnectionState.Disconnecting;
        let uncleanly = false;
        try {
            await rejectAfter(
                this.performDisconnection(),
                DISCONNECT_TIMEOUT_MS,
                `The widget did not answer within ${DISCONNECT_TIMEOUT_MS}ms`,
            );
        } catch (e) {
            logger.warn(`Failed to hang up cleanly in ${this.roomId}; ending the call locally anyway`, e);
            uncleanly = true;
        } finally {
            this.setDisconnected();
            // An unclean disconnection closes regardless: the widget is not
            // answering, so there is nothing left to keep the line open for.
            if (uncleanly || this.shouldCloseOnDisconnect()) this.close();
        }
        if (uncleanly) this.cleanUpAfterUncleanDisconnection();
    }

    /**
     * Stops further communication with the widget and tells the UI to close.
     */
    protected close(): void {
        // Now that disconnect() always closes, close() can follow the widget's
        // own hangup or its death, so it has to tolerate being called twice.
        if (this.widgetApi === null) return;
        this.widgetApi = null;
        this.emit(CallEvent.Close);
    }

    /**
     * Stops all internal timers and tasks to prepare for garbage collection.
     */
    public destroy(): void {
        if (this.connected) {
            this.setDisconnected();
            this.close();
        }
        WidgetMessagingStore.instance.off(WidgetMessagingStoreEvent.StopMessaging, this.onStopMessaging);
        this.emit(CallEvent.Destroy);
    }

    private readonly onMyMembership = async (_room: Room, membership: Membership): Promise<void> => {
        if (membership !== KnownMembership.Join) this.setDisconnected();
    };

    private readonly onStopMessaging = (uid: string): void => {
        if (uid === this.widgetUid && this.connected) {
            logger.debug("The widget died; treating this as a user hangup");
            this.setDisconnected();
            this.close();
        }
    };

    private beforeUnload = (): void => {
        this.setDisconnected();
        this.close();
    };
}

/** @knipignore - exported for tests */
export type { JitsiCallMemberContent };

/**
 * A group call using Jitsi as a backend.
 */
export class JitsiCall extends Call {
    public static readonly MEMBER_EVENT_TYPE = JitsiCallMemberEventType;
    public readonly STUCK_DEVICE_TIMEOUT_MS = 1000 * 60 * 60; // 1 hour

    private resendDevicesTimer: number | null = null;
    private participantsExpirationTimer: number | null = null;

    private constructor(widget: IApp, client: MatrixClient) {
        super(widget, client, CallType.Video);

        this.room.on(RoomStateEvent.Update, this.onRoomState);
        this.on(CallEvent.ConnectionState, this.onConnectionState);
        this.updateParticipants();
    }

    public static get(room: Room): JitsiCall | null {
        // Only supported in video rooms
        if (room.isElementVideoRoom()) {
            const apps = WidgetStore.instance.getApps(room.roomId);
            // The isVideoChannel field differentiates rich Jitsi calls from bare Jitsi widgets
            const jitsiWidget = apps.find((app) => WidgetType.JITSI.matches(app.type) && app.data?.isVideoChannel);
            if (jitsiWidget) return new JitsiCall(jitsiWidget, room.client);
        }

        return null;
    }

    public static async create(room: Room): Promise<void> {
        await WidgetUtils.addJitsiWidget(room.client, room.roomId, CallType.Video, "Group call", true, room.name);
    }

    private updateParticipants(): void {
        if (this.participantsExpirationTimer !== null) {
            clearTimeout(this.participantsExpirationTimer);
            this.participantsExpirationTimer = null;
        }

        const participants = new Map<RoomMember, Set<string>>();
        const now = Date.now();
        let allExpireAt = Infinity;

        for (const e of this.room.currentState.getStateEvents(JitsiCall.MEMBER_EVENT_TYPE)) {
            const member = this.room.getMember(e.getStateKey()!);
            const content = e.getContent<JitsiCallMemberContent>();
            const expiresAt = typeof content.expires_ts === "number" ? content.expires_ts : -Infinity;
            let devices =
                expiresAt > now && Array.isArray(content.devices)
                    ? content.devices.filter((d) => typeof d === "string")
                    : [];

            // Apply local echo for the disconnected case
            if (!this.connected && member?.userId === this.client.getUserId()) {
                devices = devices.filter((d) => d !== this.client.getDeviceId());
            }
            // Must have a connected device and still be joined to the room
            if (devices.length > 0 && member?.membership === KnownMembership.Join) {
                participants.set(member, new Set(devices));
                if (expiresAt < allExpireAt) allExpireAt = expiresAt;
            }
        }

        // Apply local echo for the connected case
        if (this.connected) {
            const localMember = this.room.getMember(this.client.getUserId()!)!;
            let devices = participants.get(localMember);
            if (devices === undefined) {
                devices = new Set();
                participants.set(localMember, devices);
            }

            devices.add(this.client.getDeviceId()!);
        }

        this.participants = participants;
        if (allExpireAt < Infinity) {
            this.participantsExpirationTimer = window.setTimeout(() => this.updateParticipants(), allExpireAt - now);
        }
    }

    /**
     * Updates our member state with the devices returned by the given function.
     * @param fn A function from the current devices to the new devices. If it
     *     returns null, the update is skipped.
     */
    private async updateDevices(fn: (devices: string[]) => string[] | null): Promise<void> {
        if (this.room.getMyMembership() !== KnownMembership.Join) return;

        const event = this.room.currentState.getStateEvents(JitsiCall.MEMBER_EVENT_TYPE, this.client.getUserId()!);
        const content = event?.getContent<JitsiCallMemberContent>();
        const expiresAt = typeof content?.expires_ts === "number" ? content.expires_ts : -Infinity;
        const devices = expiresAt > Date.now() && Array.isArray(content?.devices) ? content.devices : [];
        const newDevices = fn(devices);

        if (newDevices !== null) {
            const newContent: JitsiCallMemberContent = {
                devices: newDevices,
                expires_ts: Date.now() + this.STUCK_DEVICE_TIMEOUT_MS,
            };

            await this.client.sendStateEvent(
                this.roomId,
                JitsiCall.MEMBER_EVENT_TYPE,
                newContent,
                this.client.getUserId()!,
            );
        }
    }

    public async clean(): Promise<void> {
        const now = Date.now();
        const { devices: myDevices } = await this.client.getDevices();
        const deviceMap = new Map<string, IMyDevice>(myDevices.map((d) => [d.device_id, d]));

        // Clean up our member state by filtering out logged out devices,
        // inactive devices, and our own device (if we're disconnected)
        await this.updateDevices((devices) => {
            const newDevices = devices.filter((d) => {
                const device = deviceMap.get(d);
                return (
                    device?.last_seen_ts !== undefined &&
                    !(d === this.client.getDeviceId() && !this.connected) &&
                    now - device.last_seen_ts < this.STUCK_DEVICE_TIMEOUT_MS
                );
            });

            // Skip the update if the devices are unchanged
            return newDevices.length === devices.length ? null : newDevices;
        });
    }

    private async addOurDevice(): Promise<void> {
        await this.updateDevices((devices) => Array.from(new Set(devices).add(this.client.getDeviceId()!)));
    }

    private async removeOurDevice(): Promise<void> {
        await this.updateDevices((devices) => {
            const devicesSet = new Set(devices);
            devicesSet.delete(this.client.getDeviceId()!);
            return Array.from(devicesSet);
        });
    }

    public async start(): Promise<ClientWidgetApi> {
        const widgetApi = await super.start();
        widgetApi.on(`action:${ElementWidgetActions.JoinCall}`, this.onJoin);
        widgetApi.on(`action:${ElementWidgetActions.HangupCall}`, this.onHangup);
        ActiveWidgetStore.instance.on(ActiveWidgetStoreEvent.Dock, this.onDock);
        ActiveWidgetStore.instance.on(ActiveWidgetStoreEvent.Undock, this.onUndock);
        return widgetApi;
    }

    protected async performDisconnection(): Promise<void> {
        const widgetApi = this.widgetApi;
        if (widgetApi === null) return; // Nothing left to tell

        const response = waitForEvent(
            widgetApi,
            `action:${ElementWidgetActions.HangupCall}`,
            (ev: CustomEvent<IWidgetApiRequest>) => {
                ev.preventDefault();
                widgetApi.transport.reply(ev.detail, {}); // ack
                return true;
            },
            // disconnect() bounds this already; a second timer would only race it
            false,
        );
        const request = widgetApi.transport.send(ElementWidgetActions.HangupCall, {});
        try {
            await Promise.all([request, response]);
        } catch (e) {
            throw new Error(`Failed to hangup call in room ${this.roomId}: ${e}`);
        }
    }

    public close(): void {
        const widgetApi = this.widgetApi;
        if (widgetApi === null) return; // Already closed
        widgetApi.off(`action:${ElementWidgetActions.JoinCall}`, this.onJoin);
        widgetApi.off(`action:${ElementWidgetActions.HangupCall}`, this.onHangup);
        ActiveWidgetStore.instance.off(ActiveWidgetStoreEvent.Dock, this.onDock);
        ActiveWidgetStore.instance.off(ActiveWidgetStoreEvent.Undock, this.onUndock);
        super.close();
    }

    public destroy(): void {
        this.room.off(RoomStateEvent.Update, this.onRoomState);
        this.off(CallEvent.ConnectionState, this.onConnectionState);
        if (this.participantsExpirationTimer !== null) {
            clearTimeout(this.participantsExpirationTimer);
            this.participantsExpirationTimer = null;
        }
        if (this.resendDevicesTimer !== null) {
            clearInterval(this.resendDevicesTimer);
            this.resendDevicesTimer = null;
        }

        super.destroy();
    }

    private readonly onRoomState = (): void => this.updateParticipants();

    private readonly onConnectionState = async (state: ConnectionState, prevState: ConnectionState): Promise<void> => {
        if (state === ConnectionState.Connected && !isConnected(prevState)) {
            this.updateParticipants(); // Local echo

            // Tell others that we're connected, by adding our device to room state
            await this.addOurDevice();
            // Re-add this device every so often so our video member event doesn't become stale
            this.resendDevicesTimer = window.setInterval(
                async (): Promise<void> => {
                    logger.debug(`Resending video member event for ${this.roomId}`);
                    await this.addOurDevice();
                },
                (this.STUCK_DEVICE_TIMEOUT_MS * 3) / 4,
            );
        } else if (state === ConnectionState.Disconnected && isConnected(prevState)) {
            this.updateParticipants(); // Local echo

            if (this.resendDevicesTimer !== null) {
                clearInterval(this.resendDevicesTimer);
                this.resendDevicesTimer = null;
            }
            // Tell others that we're disconnected, by removing our device from room state
            await this.removeOurDevice();
        }
    };

    private readonly onDock = async (): Promise<void> => {
        // The widget is no longer a PiP, so let's restore the default layout
        await this.widgetApi!.transport.send(ElementWidgetActions.TileLayout, {});
    };

    private readonly onUndock = async (): Promise<void> => {
        // The widget has become a PiP, so let's switch Jitsi to spotlight mode
        // to only show the active speaker and economize on space
        await this.widgetApi!.transport.send(ElementWidgetActions.SpotlightLayout, {});
    };

    private readonly onJoin = (ev: CustomEvent<IWidgetApiRequest>): void => {
        ev.preventDefault();
        this.widgetApi!.transport.reply(ev.detail, {}); // ack
        this.setConnected();
    };

    private readonly onHangup = async (ev: CustomEvent<IWidgetApiRequest>): Promise<void> => {
        // If we're already in the middle of a client-initiated disconnection,
        // ignore the event
        if (this.connectionState === ConnectionState.Disconnecting) return;

        ev.preventDefault();
        this.widgetApi!.transport.reply(ev.detail, {}); // ack
        this.setDisconnected();
        if (!isVideoRoom(this.room)) this.close();
    };
}

export enum ElementCallIntent {
    StartCall = "start_call",
    JoinExisting = "join_existing",
    StartCallVoice = "start_call_voice",
    JoinExistingVoice = "join_existing_voice",
    StartCallDM = "start_call_dm",
    StartCallDMVoice = "start_call_dm_voice",
    JoinExistingDM = "join_existing_dm",
    JoinExistingDMVoice = "join_existing_dm_voice",
}

/**
 * Parameters to be passed during widget creation.
 * These parameters are hints only, and may not be accepted by the implementation.
 */
export interface WidgetGenerationParameters {
    /**
     * Skip showing the lobby screen of a call.
     */
    skipLobby?: boolean;
    /**
     * Does the user intent to start a voice call?
     */
    voiceOnly?: boolean;
}

/**
 * Parameters to be passed during widget creation.
 * These parameters are hints only, and may not be accepted by the implementation.
 */
export interface WidgetGenerationParameters {
    /**
     * Skip showing the lobby screen of a call.
     */
    skipLobby?: boolean;
}

/**
 * A group call using MSC3401 and Element Call as a backend.
 * (somewhat cheekily named)
 */
export class ElementCall extends Call {
    public readonly STUCK_DEVICE_TIMEOUT_MS = 1000 * 60 * 60; // 1 hour

    private settingsStoreCallEncryptionWatcher?: string;
    private terminationTimer?: number;

    /**
     * The mic and camera state this call still has to be put into, from the left
     * panel's toggles. Null once the widget has confirmed it, after which the
     * user's choices within the call itself are left alone.
     */
    private pendingDeviceMuteState: Required<DeviceMuteState> | null = null;

    private _deviceMuteState: Required<DeviceMuteState> | null = null;

    /**
     * The mic and camera state the widget last reported being in, or null while
     * it has not said yet. The left panel renders from this, so that its buttons
     * agree with the call's own controls whichever of them was used.
     */
    public get deviceMuteState(): Required<DeviceMuteState> | null {
        return this._deviceMuteState;
    }

    private setDeviceMuteStateFromWidget(reported: DeviceMuteState | undefined): void {
        // A partial report says nothing about the field it omits, so there is no
        // complete state to publish yet.
        if (reported?.audio_enabled === undefined || reported.video_enabled === undefined) return;

        const next: Required<DeviceMuteState> = {
            audio_enabled: reported.audio_enabled,
            video_enabled: reported.video_enabled,
        };
        if (deviceMuteStateMatches(this._deviceMuteState ?? undefined, next)) return;

        this._deviceMuteState = next;
        this.emit(CallEvent.DeviceMuteState, next);
    }

    /**
     * Turn the mic or camera on or off in a call that is already running. Fields
     * left out are unchanged.
     *
     * Unlike the left panel's join defaults this takes effect immediately, so it
     * does not go through {@link pendingDeviceMuteState}: the widget only ignores
     * the request before it has enumerated its devices, which is long past by the
     * time a user can press a button in a call they are already in.
     */
    public async setDeviceMute(state: DeviceMuteState): Promise<void> {
        if (this.widgetApi === null) return;

        try {
            const result = await this.widgetApi.transport.send<DeviceMuteState, DeviceMuteState>(
                ElementWidgetActions.DeviceMute,
                state,
            );
            this.setDeviceMuteStateFromWidget(result);
        } catch (e) {
            logger.warn(`Failed to change the mic or camera state for the call in ${this.roomId}`, e);
        }
    }

    public get presented(): boolean {
        return super.presented;
    }
    public set presented(value: boolean) {
        super.presented = value;
        this.checkDestroy();
    }

    public widgetGenerationParameters: WidgetGenerationParameters = {};

    /**
     * Calculate the correct intent (and associated parameters) for an Element Call room. Paarameters
     * will be applied to the `params` instance.
     *
     * @param params Existing URL parameters
     * @param client The current client.
     * @param roomId The room ID for the call.
     */
    private static appendRoomParams(
        params: URLSearchParams,
        client: MatrixClient,
        roomId: string,
        { voiceOnly }: WidgetGenerationParameters,
    ): void {
        const room = client.getRoom(roomId);
        if (!room) {
            // If the room isn't known then skip setting an intent.
            return;
        } else if (isVideoRoom(room)) {
            // Video rooms already exist, so just treat as if we're joining a group call.
            //
            // Voice rather than plain JoinExisting: Element Call reads the intent
            // to decide what the lobby starts with, and the video intent turns the
            // camera on. Arriving in a call with video already live is startling in
            // a way that arriving unmuted is not, and the panel has a camera button
            // for turning it on deliberately. This matches the rule in
            // getDefaultDeviceMuteState.
            params.append("intent", ElementCallIntent.JoinExistingVoice);
            // Video rooms should always return to lobby.
            params.append("returnToLobby", "true");
            // Never skip the lobby, we always want to give the caller a chance to explicitly join.
            params.append("skipLobby", "false");
            return;
        }

        const isDM = !!DMRoomMap.shared().getUserIdForRoomId(room.roomId);
        const oldestCallMember = client.matrixRTC.getRoomSession(room).getOldestMembership();
        const hasCallStarted = !!oldestCallMember && oldestCallMember.sender !== client.getSafeUserId();
        if (isDM) {
            if (hasCallStarted) {
                params.append(
                    "intent",
                    voiceOnly ? ElementCallIntent.JoinExistingDMVoice : ElementCallIntent.JoinExistingDM,
                );
            } else {
                params.append("intent", voiceOnly ? ElementCallIntent.StartCallDMVoice : ElementCallIntent.StartCallDM);
            }
        } else {
            if (hasCallStarted) {
                params.append(
                    "intent",
                    voiceOnly ? ElementCallIntent.JoinExistingVoice : ElementCallIntent.JoinExisting,
                );
            } else {
                params.append("intent", voiceOnly ? ElementCallIntent.StartCallVoice : ElementCallIntent.StartCall);
            }
        }
    }

    /**
     * Calculate the correct analytics parameters for an Element Call room. Paarameters
     * will be applied to the `params` instance.
     *
     * @param params Existing URL parameters
     * @param client The current client.
     */
    private static appendAnalyticsParams(params: URLSearchParams, client: MatrixClient): void {
        const posthogConfig = SdkConfig.get("posthog");
        if (
            !posthogConfig?.project_api_key ||
            !posthogConfig?.api_host ||
            PosthogAnalytics.instance.getAnonymity() === Anonymity.Disabled
        ) {
            return;
        }

        const accountAnalyticsData = client.getAccountData(PosthogAnalytics.ANALYTICS_EVENT_TYPE)?.getContent();
        // The analyticsID is passed directly to element call (EC) since this codepath is only for EC and no other widget.
        // We really don't want the same analyticID's for the EC and EW posthog instances (Data on posthog should be limited/anonymized as much as possible).
        // This is prohibited in EC where a hashed version of the analyticsID is used for the actual posthog identification.
        // We can pass the raw EW analyticsID here since we need to trust EC with not sending sensitive data to posthog (EC has access to more sensible data than the analyticsID e.g. the username)
        const analyticsID: string = accountAnalyticsData?.pseudonymousAnalyticsOptIn ? accountAnalyticsData?.id : "";

        params.append("posthogUserId", analyticsID);
        params.append("posthogApiHost", posthogConfig.api_host);
        params.append("posthogApiKey", posthogConfig.project_api_key);

        // We gate passing sentry behind analytics consent as EC shares data automatically without user-consent,
        // unlike EW where data is shared upon an intentional user action (rageshake).
        const sentryConfig = SdkConfig.get("sentry");
        if (sentryConfig?.dsn) {
            params.append("sentryDsn", sentryConfig.dsn);
            params.append("sentryEnvironment", sentryConfig.environment ?? "");
        }
    }

    /**
     * Generate the correct Element Call widget URL for creating or joining a call in this room.
     * Unless `Developer.elementCallUrl` is set, the widget will use the embedded Element Call package.
     *
     * @param client
     * @param roomId
     * @param opts
     * @returns
     */
    private static generateWidgetUrl(client: MatrixClient, roomId: string, opts: WidgetGenerationParameters = {}): URL {
        const elementCallUrlOverride = SettingsStore.getValue("Developer.elementCallUrl");
        const url = elementCallUrlOverride
            ? new URL(elementCallUrlOverride)
            : // this strips hash fragment from baseUrl
              new URL("./widgets/element-call/index.html#", window.location.href);

        // Splice together the Element Call URL for this call
        // Parameters can be found in https://github.com/element-hq/element-call/blob/livekit/src/UrlParams.ts.
        const params = new URLSearchParams({
            // Template variables are used, so that this can be configured using the widget data.
            perParticipantE2EE: "$perParticipantE2EE",
            userId: client.getUserId()!,
            deviceId: client.getDeviceId()!,
            roomId: roomId,
            baseUrl: client.baseUrl,
            lang: getCurrentLanguage().replace("_", "-"),
            fontScale: (FontWatcher.getRootFontSize() / FontWatcher.getBrowserDefaultFontSize()).toString(),
            theme: "$org.matrix.msc2873.client_theme",
            // on EW we do not want the gradient EC background.
            background: "solid",
        });

        if (typeof opts.skipLobby === "boolean") {
            params.set("skipLobby", opts.skipLobby.toString());
        }

        const rageshakeSubmitUrl = SdkConfig.get("bug_report_endpoint_url");
        if (rageshakeSubmitUrl && rageshakeSubmitUrl !== BugReportEndpointURLLocal) {
            params.append("rageshakeSubmitUrl", rageshakeSubmitUrl);
        }

        if (SettingsStore.getValue("fallbackICEServerAllowed")) {
            params.append("allowIceFallback", "true");
        }

        const echoCancellation = SettingsStore.getValue("webrtc_audio_echoCancellation");
        if (!echoCancellation) {
            // the default is true, so only set if false
            params.append("echoCancellation", "false");
        }
        const noiseSuppression = SettingsStore.getValue("webrtc_audio_noiseSuppression");
        if (!noiseSuppression) {
            // the default is true, so only set if false
            params.append("noiseSuppression", "false");
        }

        // Set custom fonts
        if (SettingsStore.getValue("useSystemFont")) {
            SettingsStore.getValue("systemFont")
                .split(",")
                .map((font) => {
                    // Strip whitespace and quotes
                    font = font.trim();
                    if (font.startsWith('"') && font.endsWith('"')) font = font.slice(1, -1);
                    return font;
                })
                .forEach((font) => params.append("font", font));
        }
        this.appendAnalyticsParams(params, client);
        this.appendRoomParams(params, client, roomId, opts);

        const replacedUrl = params.toString().replace(/%24/g, "$");
        url.hash = `#?${replacedUrl}`;
        return url;
    }

    // Creates a new widget if there isn't any widget of typ Call in this room.
    private static createOrGetCallWidget(roomId: string, client: MatrixClient): IApp {
        const ecWidget = WidgetStore.instance.getApps(roomId).find((app) => WidgetType.CALL.matches(app.type));
        if (ecWidget) {
            // Always update the widget data because even if the widget is already created,
            // we might have settings changes that update the widget.
            ecWidget.data = ElementCall.getWidgetData(client, roomId, ecWidget?.data ?? {}, {});
            return ecWidget;
        }

        // To use Element Call without touching room state, we create a virtual
        // widget (one that doesn't have a corresponding state event)
        const url = ElementCall.generateWidgetUrl(client, roomId);
        return WidgetStore.instance.addVirtualWidget(
            {
                id: secureRandomString(24), // So that it's globally unique
                creatorUserId: client.getUserId()!,
                name: "Element Call",
                type: WidgetType.CALL.preferred,
                url: url.toString(),
                waitForIframeLoad: false,
                data: ElementCall.getWidgetData(client, roomId, {}, {}),
            },
            roomId,
        );
    }

    private static getWidgetData(
        client: MatrixClient,
        roomId: string,
        currentData: IWidgetData,
        overwriteData: IWidgetData,
    ): IWidgetData {
        return {
            ...currentData,
            ...overwriteData,
            perParticipantE2EE:
                client.getRoom(roomId)?.hasEncryptionStateEvent() &&
                !SettingsStore.getValue("feature_disable_call_per_sender_encryption"),
        };
    }

    private onCallEncryptionSettingsChange(): void {
        this.widget.data = ElementCall.getWidgetData(this.client, this.roomId, this.widget.data ?? {}, {});
    }

    private constructor(
        public session: MatrixRTCSession,
        widget: IApp,
        client: MatrixClient,
    ) {
        super(widget, client, session.getConsensusCallIntent() === "audio" ? CallType.Voice : CallType.Video);

        this.session.on(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipChanged);
        this.client.matrixRTC.on(MatrixRTCSessionManagerEvents.SessionEnded, this.checkDestroy);
        SettingsStore.watchSetting(
            "feature_disable_call_per_sender_encryption",
            null,
            this.onCallEncryptionSettingsChange.bind(this),
        );
        // Watched for this object's whole life rather than from start(). start()
        // is fired off unawaited by RoomViewStore, so hanging the watchers off it
        // made them depend on that call landing on the same instance the UI ends
        // up with - which it does not when the room is opened directly, and the
        // toggles then did nothing until the room was reselected.
        this.watchDeviceDefaults();
        WidgetMessagingStore.instance.on(WidgetMessagingStoreEvent.StoreMessaging, this.onStoreMessaging);
        this.updateParticipants();
    }

    public static get(room: Room, voiceOnly?: boolean): ElementCall | null {
        const apps = WidgetStore.instance.getApps(room.roomId);
        const hasEcWidget = apps.some((app) => WidgetType.CALL.matches(app.type));
        const session = room.client.matrixRTC.getRoomSession(room);

        // A call is present if we
        // - have a widget: This means the create function was called.
        // - or there is a running session where we have not yet created a widget for.
        // - or this is a call room. Then we also always want to show a call.
        if (hasEcWidget || session.memberships.length !== 0 || room.isCallRoom()) {
            // create a widget for the case we are joining a running call and don't have on yet.
            const availableOrCreatedWidget = ElementCall.createOrGetCallWidget(room.roomId, room.client);
            return new ElementCall(session, availableOrCreatedWidget, room.client);
        }

        return null;
    }

    public static create(room: Room): void {
        ElementCall.createOrGetCallWidget(room.roomId, room.client);
    }

    public async start(widgetGenerationParameters: WidgetGenerationParameters): Promise<ClientWidgetApi> {
        // Some parameters may only be set once the user has chosen to interact with the call, regenerate the URL
        // at this point in case any of the parameters have changed.
        this.widgetGenerationParameters = { ...this.widgetGenerationParameters, ...widgetGenerationParameters };
        this.widget.url = ElementCall.generateWidgetUrl(
            this.client,
            this.roomId,
            this.widgetGenerationParameters,
        ).toString();
        const widgetApi = await super.start();
        this.attachWidgetListeners(widgetApi);

        // A fresh attempt at joining, so our membership has yet to be seen again
        this.ownMembershipSeen = false;
        this.clearOwnMembershipWatchdog();

        // Join with the mic and camera state the user picked in the left panel,
        // rather than Element Call's own default of both on.
        this.pendingDeviceMuteState = getDefaultDeviceMuteState();
        void this.applyPendingDeviceMuteState();

        return widgetApi;
    }

    /**
     * Tells Element Call to hang up.
     *
     * Element Call (as of 0.22) does not send a hangup action back to us: the
     * only code that would emit one is reachable solely through
     * `CallViewModel.leave`, which nothing in Element Call calls. Its own hangup
     * button unmounts the scope that would have observed it. So waiting for that
     * echo is waiting for a message that never comes, and the ack of our own
     * request is the only confirmation available.
     *
     * The echo is still raced, in case a future Element Call starts sending it,
     * or the widget hangs up by itself while we are asking.
     */
    protected async performDisconnection(): Promise<void> {
        const widgetApi = this.widgetApi;
        if (widgetApi === null) return; // Nothing left to tell

        const response = waitForEvent(
            widgetApi,
            `action:${ElementWidgetActions.HangupCall}`,
            (ev: CustomEvent<IWidgetApiRequest>) => {
                ev.preventDefault();
                widgetApi.transport.reply(ev.detail, {}); // ack
                return true;
            },
            // disconnect() bounds this already; a second timer would only race it
            false,
        );
        const request = widgetApi.transport.send(ElementWidgetActions.HangupCall, {});
        try {
            await Promise.race([request, response]);
        } catch (e) {
            throw new Error(`Failed to hangup call in room ${this.roomId}: ${e}`);
        }
    }

    /**
     * The widget API our handlers are currently on, which is not always
     * {@link widgetApi}: a widget can be torn down and rebuilt under us, and
     * until we move across, the one we hold is dead.
     */
    private attachedWidgetApi: ClientWidgetApi | null = null;

    /**
     * Which call object is currently driving each widget.
     *
     * At most one may: a second set of handlers would answer the same actions
     * twice and fight over the call's state. In the app this never comes up,
     * because `CallStore` is the only thing that builds these - but `get()`
     * builds a fresh object every time it is called, so the invariant is worth
     * holding rather than assuming.
     */
    private static readonly attachedByWidget = new Map<string, ElementCall>();

    private attachWidgetListeners(widgetApi: ClientWidgetApi): void {
        if (this.attachedWidgetApi === widgetApi) return;

        const previous = ElementCall.attachedByWidget.get(this.widgetUid);
        if (previous !== undefined && previous !== this) previous.detachFromWidget();
        if (this.attachedWidgetApi !== null) this.detachWidgetListeners(this.attachedWidgetApi);

        widgetApi.on(`action:${ElementWidgetActions.JoinCall}`, this.onJoin);
        widgetApi.on(`action:${ElementWidgetActions.HangupCall}`, this.onHangup);
        widgetApi.on(`action:${ElementWidgetActions.Close}`, this.onClose);
        widgetApi.on(`action:${ElementWidgetActions.DeviceMute}`, this.onDeviceMute);
        this.attachedWidgetApi = widgetApi;
        ElementCall.attachedByWidget.set(this.widgetUid, this);
    }

    /**
     * Give up the widget to another call object. Losing the listeners is not
     * enough on its own: an object that can still *send* would go on pushing
     * mute states at a widget it no longer hears from, and the two would chase
     * each other.
     */
    private detachFromWidget(): void {
        if (this.attachedWidgetApi !== null) this.detachWidgetListeners(this.attachedWidgetApi);
        this.widgetApi = null;
        this.pendingDeviceMuteState = null;
    }

    private detachWidgetListeners(widgetApi: ClientWidgetApi): void {
        widgetApi.off(`action:${ElementWidgetActions.JoinCall}`, this.onJoin);
        widgetApi.off(`action:${ElementWidgetActions.HangupCall}`, this.onHangup);
        widgetApi.off(`action:${ElementWidgetActions.Close}`, this.onClose);
        widgetApi.off(`action:${ElementWidgetActions.DeviceMute}`, this.onDeviceMute);
        if (this.attachedWidgetApi === widgetApi) this.attachedWidgetApi = null;
        if (ElementCall.attachedByWidget.get(this.widgetUid) === this) {
            ElementCall.attachedByWidget.delete(this.widgetUid);
        }
    }

    /**
     * Attach to our widget's messaging whenever it appears, whoever created it.
     *
     * Not just a nicety: `start()` is the only other thing that attaches, and it
     * is not always called. `RoomViewStore` starts the call only if the room is
     * already in the client's store, and on a fresh load straight into a room it
     * is not - the sync has not landed yet - so nothing starts it. The widget
     * still renders, because `AppTile` does that independently, and the lobby
     * works, which makes it look like everything is fine. But with no listeners
     * attached, Element Call's `io.element.join` and `io.element.device_mute` are
     * rejected as "unknown or unsupported from-widget action": we never learn
     * that the user joined, the panel cannot follow the call's own mic button,
     * and nothing we send reaches the widget. Reopening the room was the only
     * cure, because that is what finally called `start()`.
     *
     * The same path covers the widget being torn down and rebuilt under us, which
     * React strict mode, a container move, and a remount all do.
     */
    private attachToMessaging(messaging: WidgetMessaging): void {
        const attach = (): void => {
            const widgetApi = messaging.widgetApi;
            if (!widgetApi || widgetApi === this.attachedWidgetApi) return;

            logger.info(`Attaching to the call widget in ${this.roomId}`);
            this.widgetApi = widgetApi;
            this.attachWidgetListeners(widgetApi);
            // The widget is on its own defaults until told otherwise, so ask for
            // the state the panel's toggles are in.
            this.pendingDeviceMuteState = getDefaultDeviceMuteState();
            void this.applyPendingDeviceMuteState();
        };

        if (messaging.widgetApi) attach();
        else messaging.once(WidgetMessagingEvent.Start, attach);
    }

    private readonly onStoreMessaging = (uid: string, messaging: WidgetMessaging): void => {
        // Attached whether or not anything has started this call - see
        // attachToMessaging. `attachedByWidget` keeps it to one driver.
        if (uid !== this.widgetUid) return;
        this.attachToMessaging(messaging);
    };

    public close(): void {
        const widgetApi = this.widgetApi;
        if (widgetApi === null) return; // Already closed
        this.detachWidgetListeners(widgetApi);
        super.close();
    }

    /**
     * A video room's widget outlives the call: `returnToLobby` puts the user
     * back in the lobby rather than closing, and they can join again from
     * there. Closing our side would take the `io.element.join` listener with
     * it, so that second join would never reach us - the call would run with
     * the panel insisting there was none, and none of its controls would work.
     *
     * Upstream had the same `close()` here, but never reached it: the hangup it
     * waited for never came, so it threw first. Fixing that exposed this.
     */
    protected shouldCloseOnDisconnect(): boolean {
        return !isVideoRoom(this.room);
    }

    /**
     * Destroy the widget outright when it would not answer a hangup.
     *
     * Element Call queues an unanswered request and replays it the next time
     * something listens, so a hangup left unanswered here would arrive at the
     * *next* call in this widget and hang that one up instead. Killing the
     * iframe is the only way to discard it. The widget is recreated on the next
     * visit, which for a call room is `RoomViewStore` doing so automatically.
     */
    protected cleanUpAfterUncleanDisconnection(): void {
        logger.info(`Destroying the unresponsive call widget in ${this.roomId}`);
        ActiveWidgetStore.instance.destroyPersistentWidget(this.widget.id, this.roomId);
        WidgetMessagingStore.instance.stopMessagingByUid(this.widgetUid);
        if (!this.room.isCallRoom()) WidgetStore.instance.removeVirtualWidget(this.widget.id, this.roomId);
    }

    protected setDisconnected(): void {
        this.ownMembershipSeen = false;
        this.clearOwnMembershipWatchdog();
        super.setDisconnected();
    }

    public destroy(): void {
        this.clearOwnMembershipWatchdog();
        this.unwatchDeviceDefaults();
        WidgetMessagingStore.instance.off(WidgetMessagingStoreEvent.StoreMessaging, this.onStoreMessaging);
        ActiveWidgetStore.instance.destroyPersistentWidget(this.widget.id, this.widget.roomId);
        WidgetStore.instance.removeVirtualWidget(this.widget.id, this.widget.roomId);
        this.session.off(MatrixRTCSessionEvent.MembershipsChanged, this.onMembershipChanged);
        this.client.matrixRTC.off(MatrixRTCSessionManagerEvents.SessionEnded, this.checkDestroy);

        SettingsStore.unwatchSetting(this.settingsStoreCallEncryptionWatcher);
        clearTimeout(this.terminationTimer);
        this.terminationTimer = undefined;

        super.destroy();
    }

    private checkDestroy = (): void => {
        // A call ceases to exist as soon as all participants leave and also the
        // user isn't looking at it (for example, waiting in an empty lobby)
        if (this.session.memberships.length === 0 && !this.presented && !this.room.isCallRoom()) this.destroy();
    };

    /**
     * Whether our own device has ever appeared in the call's memberships. Until
     * it has, its absence means the join is still in flight rather than over.
     */
    private ownMembershipSeen = false;
    private ownMembershipGoneTimer?: number;

    private hasOwnMembership(): boolean {
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();
        return this.session.memberships.some((m) => m.userId === userId && m.deviceId === deviceId);
    }

    private clearOwnMembershipWatchdog(): void {
        clearTimeout(this.ownMembershipGoneTimer);
        this.ownMembershipGoneTimer = undefined;
    }

    /**
     * Watch our own RTC membership, and treat losing it as having left.
     *
     * This is the only signal we get when the user leaves from inside Element
     * Call in a video room: `returnToLobby` suppresses the close action, and
     * Element Call sends no hangup, so nothing else would ever tell us. The
     * membership retraction, on the other hand, goes through our own widget
     * driver, so our session sees it.
     */
    private readonly onMembershipChanged = (): void => {
        this.updateParticipants();
        this.callType = this.session.getConsensusCallIntent() === "audio" ? CallType.Voice : CallType.Video;

        if (this.hasOwnMembership()) {
            this.ownMembershipSeen = true;
            this.clearOwnMembershipWatchdog();
        } else if (this.ownMembershipSeen && this.connected && this.ownMembershipGoneTimer === undefined) {
            // Debounced: a reconnect drops the membership briefly, and that is
            // not the user leaving.
            this.ownMembershipGoneTimer = window.setTimeout(() => {
                this.ownMembershipGoneTimer = undefined;
                if (this.hasOwnMembership() || !this.connected) return;
                logger.info(`Our membership of the call in ${this.roomId} is gone; the widget has left it`);
                this.setDisconnected();
            }, OWN_MEMBERSHIP_GRACE_MS);
        }
    };

    private updateParticipants(): void {
        const participants = new Map<RoomMember, Set<string>>();

        for (const m of this.session.memberships) {
            if (!m.sender) continue;
            const member = this.room.getMember(m.sender);
            if (member) {
                if (participants.has(member)) {
                    participants.get(member)?.add(m.deviceId);
                } else {
                    participants.set(member, new Set([m.deviceId]));
                }
            }
        }

        this.participants = participants;
    }

    private deviceDefaultsWatchers: string[] = [];

    private watchDeviceDefaults(): void {
        this.unwatchDeviceDefaults();
        this.deviceDefaultsWatchers = (["audioInputMuted", "videoInputMuted"] as const).map((setting) =>
            SettingsStore.watchSetting(setting, null, () => this.onDeviceDefaultsChanged()),
        );
    }

    private unwatchDeviceDefaults(): void {
        for (const ref of this.deviceDefaultsWatchers) SettingsStore.unwatchSetting(ref);
        this.deviceDefaultsWatchers = [];
    }

    private onDeviceDefaultsChanged(): void {
        // Only while waiting in the lobby. Once in the call the panel drives it
        // directly, and the toggles are about this call rather than the next
        // one - so there is no default left to push.
        if (this.connected) return;

        const desired = getDefaultDeviceMuteState();
        // Nothing to say if the widget is already in that state - which it is
        // when the change came from the widget in the first place.
        if (deviceMuteStateMatches(this._deviceMuteState ?? undefined, desired)) return;

        this.pendingDeviceMuteState = desired;
        void this.applyPendingDeviceMuteState();
    }

    /**
     * Asks the widget for the mic and camera state the left panel's toggles are
     * set to, if it is not already in it.
     *
     * Element Call ignores the request until it has enumerated its devices, and
     * says nothing when it does - so a request sent this early may simply be
     * dropped. That is what {@link pendingDeviceMuteState} is for: it survives
     * until the widget reports back a state that matches, and `onDeviceMute`
     * asks again with each report that does not.
     */
    private async applyPendingDeviceMuteState(): Promise<void> {
        const desired = this.pendingDeviceMuteState;
        if (desired === null) return;
        // Nothing to ask yet; whatever is pending will be asked for at start()
        if (this.widgetApi === null) return;

        try {
            const result = await this.widgetApi.transport.send<Required<DeviceMuteState>, DeviceMuteState>(
                ElementWidgetActions.DeviceMute,
                desired,
            );
            this.setDeviceMuteStateFromWidget(result);
            if (deviceMuteStateMatches(result, desired)) this.pendingDeviceMuteState = null;
        } catch (e) {
            logger.warn(`Failed to set the initial mic and camera state for the call in ${this.roomId}`, e);
        }
    }

    /**
     * Take the mic back off the lobby, so the panel agrees with it.
     *
     * Out of a call the panel's mic button shows the join default rather than any
     * widget's state - there is no call for it to be about. So muting in Element
     * Call's own lobby left the panel still claiming the mic was on, and it was
     * right: that is what the next call would have started as. Rather than have
     * the panel show one thing and the lobby another, the lobby's choice becomes
     * the default, which is also what the user just said they wanted.
     *
     * The mic only. The camera is always off at join whatever anyone says, so
     * there is no default to keep in step with.
     */
    private mirrorLobbyMicToDefault(reported: DeviceMuteState | undefined): void {
        // In a call the panel is already showing the call's own state
        if (this.connected) return;
        // Not while the widget is still settling into the state we asked for.
        // Those reports are the widget saying what it came up as, not the user
        // choosing anything - and adopting them would quietly overwrite the
        // stored default with Element Call's own every time a room was opened.
        if (this.pendingDeviceMuteState !== null) return;
        if (reported?.audio_enabled === undefined) return;
        // Guard the write, or this and the watcher take turns forever
        if (isCallDeviceEnabledByDefault("audio") === reported.audio_enabled) return;

        void setCallDeviceEnabledByDefault("audio", reported.audio_enabled);
    }

    private readonly onDeviceMute = (ev: CustomEvent<IWidgetApiRequest>): void => {
        ev.preventDefault();
        this.widgetApi!.transport.reply(ev.detail, {}); // ack

        // Element Call reports whenever its mute state changes, however it was
        // changed - so this is also how the left panel learns about the call's
        // own buttons being used.
        this.setDeviceMuteStateFromWidget(ev.detail.data);
        this.mirrorLobbyMicToDefault(ev.detail.data);

        const desired = this.pendingDeviceMuteState;
        if (desired === null) return; // The call's own controls are in charge from here on

        if (deviceMuteStateMatches(ev.detail.data, desired)) {
            this.pendingDeviceMuteState = null;
        } else {
            // The widget has devices now, but started in a state the user did
            // not ask for, so ask again.
            void this.applyPendingDeviceMuteState();
        }
    };

    private readonly onJoin = (ev: CustomEvent<IWidgetApiRequest>): void => {
        ev.preventDefault();
        this.widgetApi!.transport.reply(ev.detail, {}); // ack

        // Ask again for the mic and camera state the panel's toggles are set to.
        // Element Call re-derives its own from its defaults whenever it rebuilds
        // its mute state, which it does every time its devices or URL parameters
        // change - so in a room with a lobby, what we asked for at start() has
        // usually been overwritten by the time the user actually joins. There is
        // no URL parameter for the mic, so this is the only way to carry that
        // choice across the lobby.
        this.pendingDeviceMuteState = getDefaultDeviceMuteState();
        void this.applyPendingDeviceMuteState();

        this.setConnected();
    };

    private readonly onHangup = async (ev: CustomEvent<IWidgetApiRequest>): Promise<void> => {
        // If we're already in the middle of a client-initiated disconnection,
        // ignore the event
        if (this.connectionState === ConnectionState.Disconnecting) return;

        ev.preventDefault();
        this.widgetApi!.transport.reply(ev.detail, {}); // ack
        this.setDisconnected();
    };

    private readonly onClose = async (ev: CustomEvent<IWidgetApiRequest>): Promise<void> => {
        ev.preventDefault();
        this.widgetApi!.transport.reply(ev.detail, {}); // ack
        this.setDisconnected(); // Just in case the widget forgot to emit a hangup action (maybe it's in an error state)
        this.close(); // User is done with the call; tell the UI to close it
    };

    /**
     * Retracts a membership this device left behind by disconnecting uncleanly.
     *
     * The room list's "call in progress" badge is driven purely by the call's
     * memberships, so a membership our previous run never got to retract - the
     * app was killed, or the widget stopped answering - shows an ongoing call to
     * everyone, including us, for as long as it sits there. New-style RTC
     * memberships never expire client-side, so without this nothing would ever
     * take it away except the server's delayed leave event, which not every
     * homeserver implements.
     *
     * Both representations have to be handled: which one is in use is Element
     * Call's `matrix_rtc_mode`, and its shipped config does not set it, so the
     * legacy state event is the usual case and the sticky event is what a user
     * who turned on Matrix 2.0 has.
     *
     * Only ever touches our own device's membership. Another device of ours may
     * be in the call legitimately, and its membership must survive.
     */
    public async clean(): Promise<void> {
        if (this.connected) return; // Never retract a membership we are using
        const userId = this.client.getUserId();
        const deviceId = this.client.getDeviceId();
        if (userId === null || deviceId === null) return;

        // Legacy: a state event, retracted by emptying it.
        try {
            const events = this.room.currentState.getStateEvents(EventType.GroupCallMemberPrefix);
            for (const event of events) {
                const content = event.getContent();
                const stateKey = event.getStateKey();
                if (event.getSender() !== userId || stateKey === undefined) continue;
                // An empty content is already a leave. A content without our
                // device id is either another device's or the ancient user-keyed
                // form, which says nothing about which device it came from.
                if (Object.keys(content).length === 0 || content.device_id !== deviceId) continue;

                logger.info(`Retracting a stale call membership in ${this.roomId}`);
                await this.client.sendStateEvent(this.roomId, EventType.GroupCallMemberPrefix, {}, stateKey);
            }
        } catch (e) {
            logger.warn(`Failed to clean up a stale call membership in ${this.roomId}`, e);
        }

        // MSC4354: a sticky event, retracted by re-sending it with nothing but
        // its sticky key - which is what the js-sdk's own leave does.
        try {
            for (const event of this.room._unstable_getStickyEvents()) {
                if (event.getType() !== EventType.RTCMembership || event.getSender() !== userId) continue;
                const content = event.getContent();
                const stickyKey = content["msc4354_sticky_key"];
                if (typeof stickyKey !== "string") continue;
                if (Object.keys(content).every((key) => key === "msc4354_sticky_key")) continue; // Already a leave
                if (content.member?.user_id !== userId || content.member?.device_id !== deviceId) continue;

                logger.info(`Retracting a stale sticky call membership in ${this.roomId}`);
                await this.client._unstable_sendStickyEvent(
                    this.roomId,
                    MEMBERSHIP_STICKY_DURATION_MS,
                    null,
                    EventType.RTCMembership,
                    { msc4354_sticky_key: stickyKey },
                );
            }
        } catch (e) {
            // A server without MSC4354 throws UnsupportedStickyEventsEndpointError
            // here, which is the ordinary case rather than a problem.
            logger.debug(`Could not clean up sticky call memberships in ${this.roomId}`, e);
        }
    }
}
