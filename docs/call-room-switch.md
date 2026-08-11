# Getting dropped from a call by changing room

A user in a voice call changes room. The room they clicked opens for a moment and
then snaps back to the one they were in, so they have to click again — and by then
they are out of the call. Intermittent, and so far only seen on Arch.

This note is the reasoning behind the local changes listed in
[MAINTAINING.md](MAINTAINING.md); delete it once they are upstream or no longer
needed.

## The two symptoms are one event

A call runs in a widget. Whenever that widget's messaging stops, `Call` has no way
to tell a crash from a hangup, so it assumes the latter
(`apps/web/src/models/Call.ts`):

```ts
private readonly onStopMessaging = (uid: string): void => {
    if (uid === this.widgetUid && this.connected) {
        logger.debug("The widget died; treating this as a user hangup");
        this.setDisconnected();
        this.close();
    }
};
```

`close()` emits `CallEvent.Close`. `CallView` passes that straight to
`RoomView.onCallClose`, which used to dispatch `view_room` for **its own** room to
stop showing the call. `RoomView` is rebuilt per room, so mid-navigation it is
still mounted for the room being left — and that dispatch puts the user back
there. One dead widget, both symptoms: the hangup and the bounce.

The giveaway in a rageshake is that debug line landing at the moment of the bounce.

## Why the widget dies

The widget's iframe is a `PersistedElement`, so it survives moving between
containers. What decides whether a container teardown _destroys_ it is
`ActiveWidgetStore.isLive()`, which is the dock reference count OR the
"always on screen" flag.

Changing room hands a call widget from the room view to the picture-in-picture
container. The PiP tile is `miniMode` and so deliberately never docks, which means
the dock count is zero for the whole hand-off and the flag is the only thing
holding the widget up. And that flag is weak:

- the widget owns it — Element Call asks for it over the widget API, and we don't
  control when that lands, so there is a window after joining where it is unset;
- only one widget may be persistent at a time, so anything else claiming the slot
  drops it silently;
- the request is awaited behind `stickyPromise`, which does network work first.

Lose that race while changing room and the last container goes away with nothing
keeping the widget alive, so it is destroyed and the call ends. Nothing here is
platform-specific — it is a race, and Arch is just where it has been losing.

## What changed

Three small changes, each of which stands on its own:

1. **`Call.setConnected` claims persistence itself** and `setDisconnected`
   releases it, instead of waiting for the widget to ask. Being in a call is now
   what keeps the widget alive across the hand-off. `setDisconnected` sets the
   connection state _before_ releasing, so whoever tears down the last container
   sees a call that is already over and cleans up rather than leaving a widget
   running with nothing on screen.

2. **`AppTile` will not destroy a widget hosting a call we are connected to**,
   whatever the flag says. This covers the widget losing the persistence slot to
   another widget mid-call.

3. **`RoomView.onCallClose` does nothing if the user has already navigated away.**
   There is no call view left to close at that point, and re-asserting the room
   only undoes the navigation. This kills the bounce even when a widget dies for a
   perfectly good reason.

## Confirming it in the field

The fix removes a race, so its absence is the evidence. If a report of this comes
in anyway, the rageshake should say which part is still failing:

- `The widget died; treating this as a user hangup` still appearing at the moment
  of the drop means something is still tearing the widget down — check whether
  another widget took the persistence slot.
- A bounce with no such line means the view is being pulled back by something
  other than `onCallClose`.
