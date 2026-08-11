# The call panel — working plan

A Discord-style panel at the foot of the room list: who you are and how you sound
when idle, plus call controls once you are in a call.

This is a plan, not documentation. Delete it when the work is done and fold
whatever is still true into `call-device-defaults.md`.

## The two states

**Idle** — always visible:

```
┌────────────────────────────────────────────┐
│ (avatar)  wireless          [mic] [deafen] │
│    ●      Online                    [gear] │
└────────────────────────────────────────────┘
```

Mic and deafen here say how the _next_ call is joined. The gear opens settings.

**In a call** — a section appears above the user row:

```
┌────────────────────────────────────────────┐
│ ((•)) Voice Connected      [noise] [hangup]│
│       voice / Space name                   │
│                                            │
│       [camera]  [screen share]             │
├────────────────────────────────────────────┤
│ (avatar)  wireless          [mic] [deafen] │
│    ●      In voice                  [gear] │
└────────────────────────────────────────────┘
```

The user row does not change shape between states — only its status line
(`Online` → `In voice`) and what the mic and deafen buttons act on.

## Decisions already taken

| Question                             | Answer                                                                |
| ------------------------------------ | --------------------------------------------------------------------- |
| Camera on join                       | **Always off.** No camera join-toggle; the camera button is live-only |
| Does deafen mute the mic?            | **Yes**                                                               |
| Is the panel visible outside a call? | **Yes** — idle state above                                            |
| Where is deafen visible?             | **Room list and header too**, for people who have not joined          |

That last one is the expensive choice and it drives the mechanism below.

## What already exists

`feat/call-device-defaults` (`fe789fe390`) added mic/camera join defaults stored
in `audioInputMuted`/`videoInputMuted`, pushed into the widget with the
`io.element.device_mute` action, with `pendingDeviceMuteState` retrying because
Element Call drops that request until its devices enumerate. See
[call-device-defaults.md](call-device-defaults.md).

Its explicit design rule — _"they do not control a call that is already
running"_ — is what this work inverts. The settings plumbing and the retry
machinery carry over; the "defaults only" scoping does not.

## What the widget API allows

Element Call handles exactly four actions:

```
im.vector.hangup, io.element.close, io.element.device_mute, io.element.join
```

| Control                                                | Mechanism                                                     | Needs Element Call changes? |
| ------------------------------------------------------ | ------------------------------------------------------------- | --------------------------- |
| Mic (live)                                             | `device_mute` `audio_enabled`                                 | no                          |
| Camera (live)                                          | `device_mute` `video_enabled`                                 | no                          |
| Disconnect                                             | `im.vector.hangup`                                            | no                          |
| Settings, names, status text, noise-suppression button | Element Web only                                              | no                          |
| **Deafen — silencing others**                          | new action                                                    | **yes**                     |
| **Screen share**                                       | new action                                                    | **yes**                     |
| **Connection quality / ping**                          | new action; `connectionQuality` appears nowhere in its source | **yes**                     |

## How deafen is published

Not as a field on `m.call.member`. That event is owned by `MatrixRTCSession`
_inside the widget_, so writing to the same state key from Element Web would
clobber the membership and break the call.

Use a separate state event — `io.eledrone.call.deafen`, state key per user (or
`user|device` if per-device is wanted) — which Element Web can write directly,
since Element Web is where the button is. Upstream can then restructure
`m.call.member` freely without touching us.

Chosen over LiveKit participant attributes because attributes only reach people
already connected to the SFU, and the requirement is that deafen shows in the
room list to someone who has _not_ joined.

Two consequences to handle:

- **Debounce the publish.** Every toggle is a homeserver write, permanently in
  room history, and rate-limited — a user drumming the button will hit 429s.
  Apply the flag locally at once, publish on a delay.
- **Ignore stale events.** Only render deafen for users who appear in
  `Call.participants` (`hooks/useCall.ts:41`). A client that crashed leaves its
  event behind; if it is only ever read for current participants, no cleanup
  logic is needed.

## Phases

**1 — The panel, Element Web only.** Both states, real mic / camera / disconnect,
camera always off on join. Status line, noise-suppression button and screen share
render as placeholders. Deafen renders disabled. Shippable on its own.

**2 — Ship our own Element Call.** Build and depend on `embedded/web` from
`eledrone-call`. No user-visible change. Note the existing `eledrone-call`
pipeline publishes a _Docker image for the server_; the app embeds an **npm
package**, which is a separate artifact not built today. Everything below is
blocked on this.

**3 — Deafen, end to end.** Element Call gains an action that silences remote
audio; Element Web mutes the mic, writes the state event, and renders the icon in
the panel, the room list and the room header.

**4 — Screen share and the connection indicator.** Both need new Element Call
actions. The ping/status icon needs LiveKit connection quality surfaced first.

## Open questions

- **What does un-deafen do to the mic?** Discord remembers whether you were
  separately muted and restores that. The simpler option is to leave the mic
  muted and make the user unmute deliberately. This decides whether the panel has
  to remember pre-deafen state.
- **Is deafen per-device or per-user?** Decides the state key.
- **Does the idle deafen toggle mean "join deafened"?** If so it needs the phase 3
  action at join time, not just mid-call.
