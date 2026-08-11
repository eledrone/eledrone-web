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

| Area               | Files                                                                                           | Why                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Screen-share audio | `apps/desktop/src/screenshareAudio.ts`, `ipc.ts`, `electron-main.ts`, `displayMediaCallback.ts` | Upstream discards the `audio` field of every display-media request. See element-call#3657, element-web#29891 |
| Arch packaging     | `packaging/arch/`                                                                               | Builds this fork directly                                                                                    |
| Docs-only pushes   | `.github/workflows/tests.yml`                                                                   | `paths-ignore` on `push`, so a documentation change does not run the suites. Four lines in the `on:` block   |
| Arch package       | `apps/desktop/electron-builder.ts`                                                              | `pacman` added to `linux.target`, plus a `pacman.depends` list — the built-in default is stale for Arch      |

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

Only four files are modified and three of them minimally, so conflicts should be rare. The likely
spot is `electron-main.ts` — upstream occasionally reworks `setDisplayMediaRequestHandler`, and our
change wraps its callback. If that handler is restructured upstream, re-apply by hand:

1. the handler must receive `request` (upstream binds it as `_`)
2. `prepareScreenshareAudio()` must resolve **before** `callback(...)` — the capture source has to
   exist before the page's `getDisplayMedia` resolves
3. `setDisplayMediaCallback(callback, request.audioRequested)` must keep passing the flag

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
