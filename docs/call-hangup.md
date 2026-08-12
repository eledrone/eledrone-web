# Calls that will not end

You hang up. The call stays. The room list keeps its green call badge, the panel
keeps saying **Voice Connected**, and — worse — every other room refuses to start
a call until the app is restarted. In a voice room it happened every time; in a
1:1 it happened sometimes.

This note is the reasoning behind the local changes listed in
[MAINTAINING.md](MAINTAINING.md); delete it once they are upstream or no longer
needed.

## Element Call does not tell us when it hangs up

`ElementCall.performDisconnection` sends `im.vector.hangup` and then waits for
Element Call to send the same action back. It never does.

The only code in Element Call that emits `HangupCall` is in `LocalMember`, on the
`joinAndPublishRequested$` transition from true to false, and the only thing that
produces that transition is `CallViewModel.leave` — which nothing in Element Call
calls. Its own hangup button goes `vm.hangup()` → `GroupCallView.onLeft`, which
unmounts the very scope that would have observed the transition. The actual RTC
leave happens in a teardown cleanup, long after anything is listening.

(Read for yourself: `@element-hq/element-call-embedded` ships sourcemaps with
`sourcesContent`, so the real TypeScript is in `dist/assets/*.js.map`.)

So the wait always timed out. `disconnect()` had no `try`, so `setDisconnected()`
and `close()` never ran, and the call parked in `Disconnecting` — which
`isConnected()` counts as connected. `CallStore` only drops a call from
`connectedCalls` on `Disconnected`, and `useRoomCall` reports every _other_ room
as `Ongoing` while anything is in that set. That is the "cannot call anyone until
restart".

**1:1 calls survived by luck.** When `returnToLobby` is false,
`GroupCallView.onLeft` sends `io.element.close`, and our `onClose` handler does
the cleanup the hangup should have done. That was the only thing rescuing them,
which is why it worked until it didn't — an error exit, or the iframe going away
before the Close was sent, and there was nothing left to catch it.

**Voice rooms had no rescue at all.** `appendRoomParams` forces
`returnToLobby=true` for video rooms, and `onLeft` then skips both the Close
action and `transport.stop()`. Leaving from inside Element Call told us nothing
whatsoever.

## What changed

1. **`disconnect()` always ends the call locally.** It is idempotent, bounds the
   wait at `DISCONNECT_TIMEOUT_MS` (4s, deliberately under the widget transport's
   own 10s), and does `setDisconnected()` + `close()` in a `finally`. Telling the
   widget is best effort; our own state is not. It no longer throws when already
   disconnected either, because `CallView` calls it across every other connected
   call inside a `Promise.all` when joining a new one, and a rejection there broke
   the join.

2. **`close()` is idempotent and null-safe**, in the base class and both
   subclasses. It can now follow the widget's own hangup or its death, and
   `widgetApi!.off(...)` would have thrown the second time.

    It is also **skipped entirely for a video room**, via
    `shouldCloseOnDisconnect()`. This one is a trap. Upstream's `disconnect()`
    closed unconditionally too, but never got there — the hangup it waited for
    never came, so it threw first. Making the hangup work reached that `close()`
    for the first time, and in a video room the widget outlives the call:
    `returnToLobby` puts the user back in its lobby rather than tearing it down.
    Closing our side took the `io.element.join` listener with it, so the join
    they sent on the way back in never arrived. The call ran, and the panel
    insisted there was none. An unclean disconnection still closes — a widget
    that will not answer is not one to keep a line open to.

3. **`performDisconnection` races the ack instead of awaiting the echo.** The echo
   is still raced in, in case a future Element Call starts sending it.

4. **An unanswered hangup destroys the widget.** Element Call backlogs a request
   nothing replied to and replays it the next time something listens — so an
   unanswered hangup would arrive at the _next_ call in that widget and hang that
   one up. Killing the iframe is the only way to discard it.

5. **The RTC membership is the fallback source of truth.** Element Call's leave
   goes through our own widget driver, so our `MatrixRTCSession` sees the
   retraction even when the widget says nothing. `ElementCall` watches for its own
   `(userId, deviceId)` disappearing and, after a grace period, treats that as
   having left. The grace period matters: a reconnect drops the membership
   briefly, and that is not the user leaving. Absence only counts once our
   membership has been seen, since between joining and it landing we are
   legitimately not a participant yet.

6. **`ElementCall.clean()` does something.** It was `return Promise.resolve()`,
   which meant `CallStore`'s unclean-disconnect recovery — read `activeCallRoomIds`
   at startup, clean each room — did nothing at all for Element Call, and simply
   cleared the flag. That is the restart bug. It now retracts our own device's
   stale membership.

`clean()` has to handle both representations, because which one is in use is
Element Call's `matrix_rtc_mode` and its shipped config does not set it: the
legacy `org.matrix.msc3401.call.member` state event is the usual case, and the
MSC4354 sticky `org.matrix.msc4143.rtc.member` is what a user who turned on
Matrix 2.0 has. Both are retracted the same way the js-sdk's own leave does it —
an empty state event, or a sticky event carrying nothing but its sticky key.

It only ever touches our own device: both formats carry the originating device id,
device ids are unique per login, and the server scopes sticky events by
`(type, sender, sticky_key)` so another user is unreachable by construction. It
also refuses to run while connected. Every error is swallowed, because
`CallStore.onReady` awaits it inside a `Promise.all` and a rejection would abort
store startup — and on any server without MSC4354 the sticky path throws
`UnsupportedStickyEventsEndpointError` as a matter of course.

## What was deliberately not done

**`beforeUnload` still only cleans up locally.** `sendBeacon` is POST-only, so it
cannot issue the state-event PUT a retraction needs, and the sticky path awaits a
capability lookup and a send queue, neither of which survives unload. The server's
delayed leave event is meant to cover this, and `clean()` at the next startup is
the backstop that catches it when it doesn't.

If the restart bug is ever seen again, the thing to check is whether the homeserver
implements MSC4140 at all — `MembershipManager` silently falls back to sending no
delayed event when the endpoint 404s. `GET
/_matrix/client/unstable/org.matrix.msc4140/delayed_events` will say.

## The one that hid behind all of these

Opening a voice room **directly by URL** left the call never started at all, and
that masked itself as several different bugs: the panel would not show the call,
its controls did nothing, and the join defaults appeared to be ignored. Reopening
the room fixed all of them at once.

`RoomViewStore` decides whether to view a room's call like this:

```ts
if (payload.room_id === this.state.roomId) viewingCall = this.state.viewingCall;
else if (room && isVideoRoom(room)) viewingCall = true;
```

On a deep link the first update arrives before the sync has landed, so `room` is
null and this settles on false. Every later update for that room then takes the
first branch — it is "the same room" now — and faithfully repeats that false. The
video-room check never gets another look, so `call.start()` is never called.

The widget still appears, because `AppTile` renders it independently of any of
this, and Element Call comes up and works. But nothing on our side is listening,
so Element Call's own actions bounce:

```
Failed to send join action: Unknown or unsupported from-widget action: io.element.join
Could not send DeviceMute action to widget: Unknown or unsupported from-widget action: io.element.device_mute
```

That single line in a rageshake is the tell, and it is worth knowing what it
means: **Element Call is fine, and we simply have no handlers attached.**

Two changes, because either alone leaves a gap:

- `RoomViewStore` tests for a video room **first**, so the answer is reconsidered
  once the room is actually known rather than being frozen by the same-room
  branch. Three lines.
- `ElementCall` attaches to its widget's messaging **whenever it appears**, not
  only from `start()`. That covers the case where no further `view_room` is
  dispatched after the room becomes known — which is what still happened on the
  room the app opens with — and it covers the widget being rebuilt underneath us,
  which strict mode and any remount do.

The second needs an invariant to be safe: at most one call object may drive a
widget, held by `ElementCall.attachedByWidget`. `get()` builds a fresh object
every time it is called, and two sets of handlers on one widget answer every
action twice and fight over the call's state. Displacing one has to take its
`widgetApi` away too, not just its listeners — an object that can still _send_
goes on pushing mute states at a widget it no longer hears from, and the two
chase each other. The test suite caught both of those, which is the argument for
having written them.

Two lessons paid for the hard way here. Widget bugs are much easier to read from
Element Call's own console output than from ours — it says plainly when an action
went unanswered. And "reopening the room fixes it" almost always means something
only happens on a code path that a re-open takes; chase that, rather than the
symptom.

## Why the join defaults did not reach voice rooms

Two reasons, both fixed:

- `appendRoomParams` sent `intent=join_existing` for every video room, which
  Element Call maps to a video call intent, whose default is **mic and camera
  both on**. 1:1 calls only worked because the fork sends the `…_dm_voice`
  intents, which map to an audio intent and so default the camera off. Video rooms
  now get `join_existing_voice`.
- Element Call rebuilds its mute state from its own defaults whenever its devices
  or URL parameters change, and in a room with a lobby the user sits there for a
  while before joining — so whatever we asked for at `start()` was long gone. The
  request is now made again in `onJoin`. There is no URL parameter for the mic, so
  this is the only way to carry that choice across a lobby.
- The toggles were read **only** when the widget started. Flipping one while
  already sitting in the room did nothing, because the lobby had converged to the
  old value during `start()` and nothing pushed the new one — the only way to get
  it in was to leave the room and come back, which re-ran `start()`. So
  `ElementCall` now watches `audioInputMuted`/`videoInputMuted` and pushes each
  change at the lobby. It stops at the point of connecting: in a call those
  buttons are the call's own mute, driven straight from the panel, and a default
  has nothing left to say about them.

    That traffic runs both ways. Out of a call the panel's mic button shows the
    join default — there is no call for it to be about — so muting in Element
    Call's own lobby left the panel still claiming the mic was on. It was not
    lying: that is what the next call would have started as. Rather than have the
    two disagree, the lobby's choice is adopted as the default, which is also
    what the user just asked for. Two guards make that safe, and both are load-
    bearing: nothing is adopted while `pendingDeviceMuteState` is set, because
    those reports are Element Call saying what it came up as rather than the user
    choosing anything — adopting them would quietly overwrite the stored default
    with Element Call's own every time a room was opened — and a default that
    already matches what the widget reports is not pushed back at it, or the two
    take turns forever. The mic only: the camera is always off at join whatever
    anyone says, so there is no default to keep in step with.

    Those watchers are registered in the **constructor**, not in `start()`. That
    matters: `RoomViewStore` fires `start()` off unawaited, so hanging them off it
    made them depend on that call landing on the same instance the UI ends up
    holding — which it does not when the room is opened directly by URL. The
    symptom was the toggles doing nothing on a fresh load until the room was
    reselected. Anything that has to work for a call the user has not started yet
    belongs on the object's lifetime, not the widget's.

The cost of that second one is that it overrides someone who deliberately unmuted
in Element Call's own lobby. The panel is the fork's stated source of truth for
this, so that is the intended reading, but it is a judgement call and worth
revisiting if it annoys anyone.

## A trap worth knowing about

`utils/promise.ts`'s `timeout()` attaches a bare `.then` to the promise it is
given. The promise that creates rejects along with it and has nothing listening,
so passing it anything that can reject takes the whole worker down with an
unhandled rejection. `Call.ts` has its own `rejectAfter` for that reason. Fixing
`timeout()` itself would be a change to an inherited file for the sake of callers
that do not exist yet.
