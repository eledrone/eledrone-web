# Choosing how you join a call before you join it

Discord has a microphone and a camera button at the foot of the channel list, and
whatever they are set to is what you arrive as. Element has no such thing: Element
Call decides, and in a widget it decides both devices are on. Joining muted means
joining first and muting second, which is exactly one moment too late.

This note is the reasoning behind the local changes listed in
[MAINTAINING.md](MAINTAINING.md); delete it once they are upstream or no longer
needed.

## Where the state lives

Nowhere new. `audioInputMuted` and `videoInputMuted` are device-level settings
that upstream already defines and no longer reads — they are what the old Jitsi
`startWithAudioMuted` plumbing used. They mean exactly what we need, so
`apps/web/src/utils/call-device-defaults.ts` reads and writes those rather than
adding settings that would have to be defended on every sync.

Device level, not account level, is deliberate: the microphone and camera are
attached to this machine, so the choice of whether to join with them should be
too.

## Getting it to the widget

The embedded Element Call is a pinned npm package
(`@element-hq/element-call-embedded`), so its source is not ours to change. Two
routes were available and only one of them works:

- **URL parameters.** Element Call's `UrlParams` has no parameter for the initial
  mute state at all. `intent` gets you a camera-off default for voice calls and
  nothing else. Dead end.
- **The `io.element.device_mute` widget action.** Element Call has always
  supported this as a `toWidget` action — the host asks for a mute configuration
  and is told what the widget settled on. Upstream's `ElementCall` registers a
  handler for it purely so the `fromWidget` direction does not log errors. That is
  the route.

So `ElementCall.start()` asks for the state the toggles are set to, before the
user is in the call.

## Why one request is not enough

Element Call builds its `MuteStates` lazily, and until its devices are enumerated
`MuteState.set` is `null`. A request that arrives before then is not rejected —
`withLatestFrom` drops it and no reply is ever sent. Sending once and hoping is
therefore a coin flip decided by how fast the user's camera enumerates.

`pendingDeviceMuteState` covers that. It holds the state we are still trying to
reach and is only cleared once a state matching it comes back, either as the reply
to our request or as one of the `fromWidget` reports Element Call sends whenever
its mute state changes. Any report that does not match makes us ask again — by
which point the widget demonstrably has devices, since it just told us about them.

This cannot loop. Element Call only reports on a _change_, so a request it ignores
produces no report and no retry; a request it honours produces one report, which
matches, which clears the pending state. From then on the call's own controls are
in charge and we leave them alone.

## What the toggles deliberately do not do

They do not control a call that is already running, and they do not follow it. A
call you are in has its own mute buttons, and the sidebar toggles say only how the
next one starts. Making them do both would mean writing the in-call state back to
the settings, which sounds right until a voice call — which starts camera-off by
design — silently turns the user's camera default off for every call after it.

The one place the two do meet is `voiceOnly`: asking for a voice call means the
camera stays off no matter what the toggle says, because the user just said they
did not want video.
