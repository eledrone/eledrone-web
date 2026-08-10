# eledrone desktop builds and releases

`.github/workflows/eledrone-desktop.yml` builds the Windows and Linux desktop
apps on GitHub. It is independent of the inherited Element workflows and needs no
secrets.

## Getting a build

| Trigger | Result |
|---|---|
| push to `develop` | both platforms built, artifacts attached to the run (14 days) |
| push to `main` | both platforms built **and** a GitHub Release published |
| Actions → Run workflow | both platforms built on demand |

Artifacts from a `develop` build are **not** a Release — they live on the run page
under *Artifacts* and expire after 14 days. Only `main` populates the Releases
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
  whether an installed app should upgrade by comparing versions. Tag `v1.12.26`
  or higher; a lower number will not be offered as an upgrade to anyone already
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

| Workflow | Why |
|---|---|
| `eledrone-desktop.yml` | this one |
| `build.yml` | builds the web app |
| `tests.yml` | unit tests |
| `static_analysis.yaml` | lint and types |
| `shared-component-visual-tests.yaml` | component snapshots |

`tests.yml` and `static_analysis.yaml` currently **fail** on this fork and need
looking at; they were kept because they are genuinely useful, not because they
pass. Element's own desktop build workflows (`build_desktop_*`) are disabled —
they are superseded by this one and depend on Element's signing and publishing
setup.
