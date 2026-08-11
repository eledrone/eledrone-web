# eledrone desktop builds and releases

`.github/workflows/eledrone-desktop.yml` builds the Windows and Linux desktop
apps on GitHub. It is independent of the inherited Element workflows and needs no
secrets.

## Getting a build

| Trigger                | Result                                                        |
| ---------------------- | ------------------------------------------------------------- |
| push to `develop`      | both platforms built, artifacts attached to the run (14 days) |
| push to `main`         | both platforms built **and** a GitHub Release published       |
| Actions → Run workflow | both platforms built on demand                                |

Artifacts from a `develop` build are **not** a Release — they live on the run page
under _Artifacts_ and expire after 14 days. Only `main` populates the Releases
section, where downloads are permanent.

Development builds are downloaded from the run's **Artifacts** section. Releases
appear under **Releases** with the installers attached.

## Cutting a release

The version lives in `apps/desktop/package.json`. Releasing is: bump it on
`develop`, then merge `develop` into `main`.

```bash
# on develop
npm --prefix apps/desktop version 1.12.26 --no-git-tag-version
git commit -am "release: 1.12.26" && git push

# then release it
git checkout main && git merge --ff-only develop && git push
```

The push to `main` builds both platforms and publishes **eledrone v1.12.26**,
tagging the commit `eledrone-v1.12.26`. Nothing is tagged by hand.

If that version was already released the release step stops with a warning
rather than duplicating it — bump the version and push `main` again.

**Why the tag is prefixed:** this fork inherits every upstream element-web tag —
about 670 — and syncing upstream brings more. An unprefixed `v1.12.26` would
eventually collide with a genuine Element release of the same number.

Two rules for choosing the number:

- **Use plain semver** — `1.12.26`, not `1.12.26-eledrone.1`. Prerelease
  suffixes break MSI generation, which requires a purely numeric version.
- **Only ever go up.** The base version in `apps/desktop/package.json` is
  inherited from upstream Element (currently `1.12.25`), and Squirrel decides
  whether an installed app should upgrade by comparing versions. Use `1.12.26` or
  higher; a lower number will not be offered as an upgrade to anyone already
  running a newer build.

Development builds carry the same `package.json` version as the release will, so
tell them apart by the run number and commit, not the version.

## What these builds do not include

- **No code signing.** Windows SmartScreen warns on first run, and it is a real
  trust decision for whoever installs it. Signing needs a certificate; the hooks
  already exist (`ED_SIGNTOOL_SUBJECT_NAME`, `ED_SIGNTOOL_THUMBPRINT` in
  `electron-builder.ts`).
- **No native modules.** `matrix-seshat` is not built, so local search in
  encrypted rooms does not work. Building it needs Rust and SQLCipher on both
  runners.
- **No auto-update.** The shipped config sets no update URL, so installed
  builds never update themselves. Distribute new versions manually.
- **No macOS build.** It requires an Apple Developer certificate to produce
  anything that will launch on another machine.

## Why the web app is built here

The workflow runs `pnpm build` in `apps/web` and packs the result into
`webapp.asar` itself. The inherited flow uses `pnpm run fetch`, which downloads
upstream element-web's **prebuilt** release tarball — that would silently ship
Element's branding and none of this fork's changes.

## Inherited Element workflows

The fork came with ~40 workflows from element-web. Most expect Element's own
infrastructure — Netlify, Localazy, Docker Hub, npm, their release automation and
issue triage — and fail here. They have been moved to
`.github/workflows-disabled/`, which stops GitHub running them while keeping the
files for reference. Move one back into `.github/workflows/` to re-enable it.

Still active:

| Workflow               | Why                                 |
| ---------------------- | ----------------------------------- |
| `eledrone-desktop.yml` | builds and releases the desktop app |
| `tests.yml`            | unit tests                          |
| `static_analysis.yaml` | lint and types                      |

`build.yml` is disabled because `eledrone-desktop.yml` builds the web app itself,
so running both did the same work twice. The shared component visual tests are
disabled as they only matter when changing those components. Element's own
`build_desktop_*` workflows are disabled too: superseded by this one, and
dependent on Element's signing and publishing setup.

## Regenerating snapshots and running the format check

Snapshots regenerate identically on Windows and Linux, so do it wherever you are:

```bash
pnpm test:snapshots:update      # both suites, from the repository root
```

That is `jest --ci -u` in `apps/web` followed by `vitest run -u` at the root; run
either alone if you only need one.

Afterwards, read the diff before committing. It should contain only what you
expected to change — a snapshot moving for no reason you can name means something
about the environment differs from CI, not that the snapshot was stale.

**One check still has to run on Linux:** `pnpm lint:fmt` varies with line endings
and reports **every** file as misformatted on a Windows checkout (CRLF vs LF).

Two others used to, and the fixes are worth knowing about because they are easy
to undo by accident:

- **CSS module class names** were derived from the absolute file path, so Windows
  and Linux produced different names (`_flex_190os_17` vs `_flex_4dswl_9`) for
  identical source. They are baked into the `shared-components` bundle and reach
  consumers' snapshots, so snapshots only matched on the platform that built the
  package. `generateScopedName` in `packages/shared-components/vite.config.ts`
  now hashes a repository-relative path with forward slashes.

  That config is listed in the `build` target's `inputs` in
  `packages/shared-components/project.json`. It has to be: Nx caches the build,
  and a config change that is not an input does not invalidate the cache — the
  build silently replays a stale `dist/` and the fix appears not to work.

- **Date formatting** followed the machine timezone, so regenerating the
  `DateUtils` inline snapshots outside UTC rewrote the times (`"19:10"` became
  `"17:10"`). Both runners now pin `TZ=UTC` themselves, in `vitest.config.ts` and
  `apps/web/jest.config.ts`, rather than relying on the caller to set it.

## Tests that fail on Windows

Two inherited desktop tests assume POSIX path separators and fail on a Windows
checkout. They are upstream's, they pass on CI, and they are left alone so that
syncing upstream does not conflict:

| Test                                            | Expects       | Gets on Windows |
| ----------------------------------------------- | ------------- | --------------- |
| `apps/desktop/src/utils.test.ts` › `tryPaths`    | `dir/dirB/`   | `dir\dirB/`     |
| `apps/desktop/src/args.test.ts` › old Riot dirs  | `/Users/...`  | `\Users\...`    |

`MatrixChat` › qr login completed also fails locally, and `ForgotPassword` ›
passwords-mismatch fails only under full-suite load. Neither is related to this
fork — the qr test fails identically with `brand` reverted to `Element`, and no
commit here touches `MatrixChat` or `Lifecycle`.

Note the desktop tests need Electron downloaded (`node_modules/electron`), which
a `--frozen-lockfile` install on a machine that skipped postinstall may not have.
They fail to load entirely if it is missing.

## Brand name in tests

The brand is configurable and rendered into user-visible strings, so tests that
assert those strings hardcode whatever the configured brand is. After changing
`brand`, expect failures in roughly 110 snapshots plus a dozen explicit
assertions — the pusher payload, OAuth dynamic client registration name, device
display name, browser support toast, and several error dialogs.

Tests that pass a brand in as explicit config or a mock are unaffected: they
exercise whatever they are given rather than the configured default.
