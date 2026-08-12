# Maintaining eledrone

`eledrone-web` is a fork of [element-hq/element-web](https://github.com/element-hq/element-web)
carrying local changes on top of upstream.

## Layout

| Ref       | Purpose                                                                                |
| --------- | -------------------------------------------------------------------------------------- |
| `develop` | **the trunk** — upstream plus every local change; this is what gets built and released |

All work lands on `develop`, matching the branch name upstream develops on. Upstream is merged into
it, never rebased. History is therefore never rewritten, so a commit pinned in a build, a tag, or a
package someone already installed stays valid forever. The cost is merge commits in the log, which is
a fair trade.

Note this differs from a stock fork, where `develop` mirrors upstream untouched: here it carries local
changes, so `git merge upstream/develop` will occasionally need conflict resolution rather than always
fast-forwarding.

## Local changes

| Area                      | Files                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Screen-share audio        | `apps/desktop/src/screenshareAudio.ts`, `ipc.ts`, `electron-main.ts`, `displayMediaCallback.ts`                                                                                                                                                                                                                                                               | Upstream discards the `audio` field of every display-media request. See element-call#3657, element-web#29891                                                                                                                                                                             |
| Arch packaging            | `packaging/arch/`                                                                                                                                                                                                                                                                                                                                             | Builds this fork directly                                                                                                                                                                                                                                                                |
| Docs-only pushes          | `.github/workflows/tests.yml`                                                                                                                                                                                                                                                                                                                                 | `paths-ignore` on `push`, so a documentation change does not run the suites. Four lines in the `on:` block                                                                                                                                                                               |
| Arch package              | `apps/desktop/electron-builder.ts`                                                                                                                                                                                                                                                                                                                            | `pacman` added to `linux.target`, plus a `pacman.depends` list — the built-in default is stale for Arch                                                                                                                                                                                  |
| Call survives room switch | `apps/web/src/models/Call.ts`, `components/views/elements/AppTile.tsx`, `components/structures/RoomView.tsx`                                                                                                                                                                                                                                                  | Changing room could hang the user up and bounce the view back. Upstream leaves a connected call's widget alive on a flag the widget sets asynchronously, and `RoomView` re-asserts its own room when a call closes. Worth offering upstream — see [the write-up](call-room-switch.md)    |
| Element Call itself       | `apps/web/package.json`                                                                                                                                                                                                                                                                                                                                       | The embedded widget comes from this fork's own build rather than the registry, so changes to Element Call can reach the app at all — see [the write-up](element-call-supply.md)                                                                                                          |
| Widget RTC transports     | `apps/web/src/stores/widgets/ElementWidgetDriver.ts`                                                                                                                                                                                                                                                                                                          | One `allowedCapabilities.add` for MSC4515, in the block that already trusts our own call widget. Without it every call opened a permission prompt naming a raw MSC string. Drop this once the widget-api we ship knows the capability — see [the write-up](element-call-supply.md)       |
| Mic/camera join defaults  | `apps/web/src/utils/call-device-defaults.ts`, `models/Call.ts`                                                                                                                                                                                                                                                                                                | Discord-style toggles saying how the next call is joined. `Call.ts` is inherited — see [the write-up](call-device-defaults.md)                                                                                                                                                           |
| Calls that will not end   | `apps/web/src/models/Call.ts`, `hooks/useConnectedCall.ts`, `stores/RoomViewStore.tsx`                                                                                                                                                                                                                                                                        | Element Call never sends a hangup back, so `disconnect()` waited forever and left the call marked connected; and `ElementCall.clean()` was a stub, so nothing ever retracted a stale membership. `Call.ts` is inherited — see [the write-up](call-hangup.md)                             |
| Themes                    | `apps/desktop/src/themes.ts`, `ipc.ts`, `preload.cts`, `electron-main.ts`, `apps/web/src/theming/*`, `components/views/settings/ThemePanel.tsx`, `tabs/user/AppearanceUserSettingsTab.tsx`, `BasePlatform.ts`, `vector/platform/ElectronPlatform.tsx`, `vector/init.tsx`, `settings/Settings.tsx`, `@types/global.d.ts`                                       | User CSS themes from a watched folder, plus a colour switcher underneath them. Most of the web-side files are inherited but take only a line or two each - see [the write-up](eledrone-themes.md)                                                                                        |
| Toasts over the call      | `apps/web/src/components/structures/ToastContainer.tsx`, `res/css/_common.pcss`                                                                                                                                                                                                                                                                               | A call widget lives in a `<body>`-level container and covered every toast, including "verify this device". The toasts are portalled out to their own container and the `<body>`-level containers given an explicit stacking order — see [the write-up](eledrone-themes.md#the-call-view) |
| The call panel            | `apps/web/src/components/views/voip/CallPanel*.tsx`, `structures/LoggedInView.tsx`, `views/spaces/SpacePanel.tsx`, `QuickSettingsButton.tsx`, `viewmodels/structures/ResizerViewModel.ts`, `packages/shared-components/src/menus/UserMenu/UserMenu.tsx`, `resize/panel/LeftResizablePanelView.tsx`, `res/css/structures/_MatrixChat.pcss`, `_SpacePanel.pcss` | A panel along the foot of the app, spanning the space rail and the room list. Takes the user menu and quick settings out of the rail, and removes left-panel collapsing entirely. Most of these files are inherited — see [the write-up](call-panel.md)                                  |

## Syncing with upstream

```bash
git fetch upstream --tags
git checkout develop
git merge upstream/develop
# resolve conflicts, then:
pnpm install
(cd apps/desktop && pnpm run lint:types)
git push origin develop && git push origin --tags
```

Tags matter: `pkgver()` derives the package version from `git describe`, so a fork without upstream's
tags produces a nonsense version.

### Where conflicts will show up

Few files are modified and most of them minimally, so conflicts should be rare. The likely
spot is `electron-main.ts` — upstream occasionally reworks `setDisplayMediaRequestHandler`, and our
change wraps its callback. If that handler is restructured upstream, re-apply by hand:

1. the handler must receive `request` (upstream binds it as `_`)
2. `prepareScreenshareAudio()` must resolve **before** `callback(...)` — the capture source has to
   exist before the page's `getDisplayMedia` resolves
3. `setDisplayMediaCallback(callback, request.audioRequested)` must keep passing the flag

The other spot is the widget and call lifecycle — `Call.ts`, `AppTile.tsx`, `RoomView.tsx` — which
upstream is actively changing. Each of the three changes stands alone and
[the write-up](call-room-switch.md) says what each one is for, so re-apply whichever still applies
rather than the diff as a block.

## Building

**Arch:**

```bash
cd packaging/arch && makepkg -si
```

Builds `eledrone-web` and `eledrone-desktop`. Both are required: the desktop package ships only the
Electron shell and symlinks its webapp from the web package.

**Windows:**

```powershell
corepack pnpm install
cd apps/web; corepack pnpm build                       # build THIS fork's webapp
cd ../desktop
cp element.io/release/config.json ../web/webapp/config.json
corepack pnpm exec asar p ../web/webapp webapp.asar
corepack pnpm run build
```

Do **not** use `pnpm run fetch` here. It downloads upstream element-web's prebuilt
tarball, so the installer would ship Element's branding rather than this fork's —
the same reason the workflow builds the webapp itself. And `--cfgdir ""` skips the
config file outright, which produces an app that starts up complaining the server
configuration is missing.

Copying `config.json` is not optional: `apps/web/config.json` is gitignored, so a
clean checkout builds a webapp with no config, and the resulting installer cannot
get past its first screen. If a local build has one anyway, it is a leftover in
`apps/web/webapp/` from an earlier build — that directory is not cleaned, which is
exactly how this went unnoticed.

Artifacts land in `apps/desktop/dist/` (unpacked directory, MSI, and Squirrel installer). Unsigned,
so SmartScreen warns on first run. Native modules (`hak`/seshat) are skipped — that only costs
encrypted-room search, and it logs a harmless `matrix-seshat` module-not-found on startup.

## Gotchas worth remembering

- **`pactl` output is localised.** Anything parsing it must force `LC_ALL=C`, or it silently finds
  nothing on a non-English system.
- **`pactl get-default-sink` only exists from PulseAudio 15.** Fall back to parsing `pactl info`.
- **Chromium never enumerates monitor sources** (`device.class = "monitor"`). Desktop audio has to be
  exposed through a _remapped_ source, which is why the routing exists at all.
- **Element's own playback must stay out of the share sink**, or remote participants hear themselves.
- **Electron's `audio: "loopback"` is Windows-only.** Passing it elsewhere breaks screen sharing.
- **`git describe` needs `--match "v*"`** — the repo carries tags like `module/banner/v1.0.0`.
