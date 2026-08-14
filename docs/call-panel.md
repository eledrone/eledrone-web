# The call panel

A Discord-style panel along the foot of the app: who you are and how you sound
when idle, plus call controls once you are in a call.

This note is the reasoning behind the local changes listed in
[MAINTAINING.md](MAINTAINING.md); delete it once they are upstream or no longer
needed. The join-time mic and camera defaults it drives are described in
[call-device-defaults.md](call-device-defaults.md), and the disconnection
machinery behind its hangup button in [call-hangup.md](call-hangup.md).

## The two states

**Idle** — always visible:

```
┌────────────────────────────────────────────┐
│ (avatar)  wireless          [mic] [deafen] │
│    ●      Online                    [gear] │
└────────────────────────────────────────────┘
```

Mic and deafen here say how the _next_ call is joined.

**In a call** — a section appears above the user row:

```
┌────────────────────────────────────────────┐
│ ((•)) Voice Connected      [noise] [hangup]│
│       Space name     05:23                 │
│                                            │
│       [camera]  [screen share]             │
├────────────────────────────────────────────┤
│ (avatar)  wireless          [mic] [deafen] │
│    ●      In voice                  [gear] │
└────────────────────────────────────────────┘
```

The clock counts from the moment the call connects, and is tinted to match the
line above it so the state and its duration read as one thing. It is the room
name that gives up width as the panel narrows, never the clock: a name still
reads at a few characters, and a clipped clock does not.

The user row does not change shape between states — only its status line
(`Online` → `In voice`) and what the mic and deafen buttons act on.

## Where it sits, and why that was awkward

It spans the foot of the space rail **and** the room list, so it cannot be a child
of either. The obvious arrangement — wrap both columns in a flex column and put
the panel underneath — does not work: the resizable layout is a
`react-resizable-panels` group, and the group finds its panels by walking its own
direct DOM children looking for `data-panel`. Put anything between the group and
its panels and it finds one panel instead of two, produces no separator hit
region, and dragging the separator silently stops working.

So `CallPanelDock` sits **outside** the group, as a sibling, absolutely positioned
over the corner it covers. `.mx_MatrixChat` is already `position: relative` and the
group is its only in-flow child, so the two boxes coincide and
`inset-block-end: 0; inset-inline-start: 0` lands where it should. Being outside
the group also means the group's `overflow: hidden` cannot clip it.

The cost is that the width has to be measured rather than inherited.
`CallPanelDock` keeps one `ResizeObserver` and writes two custom properties onto
`.mx_MatrixChat`:

| Property                      | Is                                                     |
| ----------------------------- | ------------------------------------------------------ |
| `--eledrone-call-dock-width`  | the room list's right edge, relative to the app's left |
| `--eledrone-call-dock-height` | the dock's own height, which grows when a call starts  |

The room list's right edge already includes the rail, so one measurement covers
both columns. Three things are observed, and all three are needed: the room list
(the separator resizes it), the rail (expanding it _moves_ the room list without
resizing it, because the group preserves pixel sizes, so nothing else would fire),
and the dock itself. Writes are guarded behind a last-value check — the dock is
observed and its width comes from a property we set, so writing unconditionally is
a feedback loop that produces `ResizeObserver loop completed with undelivered
notifications`.

The height is a property rather than a layout consequence because the dock
overlays: `.mx_SpacePanel` and `.mx_RoomListPanel` both reserve it with
`padding-block-end`, so nothing ends up hidden underneath. Note there is no global
`box-sizing: border-box` in this codebase, so both set it locally.

One inherited-CSS edit was needed: `_MatrixChat.pcss` gives every child that is
not on a small exclusion list `height: 100%`, which would make the dock cover the
whole app. `.mx_CallPanelDock` joins that list.

## Adaptivity

The panel never wraps, never hides a control, and never changes shape. It only
ever says less: as it narrows the text truncates, "userna…" over "In voic…", down
to a few characters. The buttons and the avatar are `flex: 0 0 auto`, since a
Compound `IconButton` is a flex item like any other and would otherwise be
squeezed narrower than its own icon.

The trap here is `Flex`'s default `align="start"`. In a **column** that is what
sizes children horizontally, so every column needs `align="stretch"` — twice
over. Without it on the panel itself the rows sat at their intrinsic ~210px,
short of the sidebar's edge. Without it on the text columns the lines took their
full length and overflowed rather than truncating, because `text-overflow:
ellipsis` does nothing until the box is narrower than the text in it.

The floor that keeps this honest: the user row needs about 172px, and the room
list's own `minSize` of 200px plus the 68px rail gives 268px. Anyone adding a
fourth control should redo that sum; it is written down in `_CallPanel.pcss`.

## The room list no longer collapses

It used to collapse to zero three ways: on any call connecting, below a 768px
viewport, and on double-clicking the separator. All three are gone, along with the
whole `auto-collapse` mechanism and the `collapsible` prop on the panel. The panel
lives along the foot of that column and has to stay legible, and a bar hanging off
a 68px rail is not a useful thing to offer.

The collapse-on-call one was also a bug in its own right: joining a voice room
squashed the room list, which is not something anyone asked for.

A collapsed state stored by an older version is ignored rather than migrated —
reading it would hide the panel once and teach the user nothing. Clicking the
separator still expands a panel found at zero width, as a way out of exactly that.

## What moved here from the space rail

The user menu and the quick settings button, both of them. Everything a user does
to themselves is now in one place, and the rail is only spaces.

- The avatar **is** the user menu's trigger, the same component with the same
  behaviour, opening upwards instead of to the right. `UserMenuView` gained
  optional `side` and `align` props for that, defaulting to what it did before.
  `Action.ToggleUserMenu` moved with it — Ctrl+Shift+U still works. It must not be
  handled in both places at once, or the two subscribers toggle twice and cancel
  each other out.
- The gear is `QuickSettingsButton`, unchanged apart from a tooltip placement and
  one new entry: the voice settings, which are worth a single click from a panel
  whose whole subject is the microphone.

Both were spaced for a vertical rail, so the panel resets their margins.

## Still to do

Deafen, screen share and the connection indicator all need Element Call to gain
actions it does not have, so they render disabled rather than hidden — the panel
keeps its shape for when they start working. Shipping our own Element Call build
is what unblocks them; the existing `eledrone-call` pipeline publishes a Docker
image for the server, while the app embeds an npm package, which is a separate
artifact not built today.

When deafen does arrive it should be published as its own state event
(`io.eledrone.call.deafen`, state key per user), **not** as a field on
`m.call.member`: that event belongs to `MatrixRTCSession` inside the widget, and
writing to the same state key from here would clobber the membership and break the
call. Publish on a debounce — every toggle is a homeserver write, permanently in
room history and rate-limited — and only render it for users who are in
`Call.participants`, so a client that crashed and left its event behind needs no
cleanup logic.
