# eledrone desktop builds and releases

`.github/workflows/eledrone-desktop.yml` builds the Windows and Linux desktop
apps on GitHub. It is independent of the inherited Element workflows and needs no
secrets.

## Getting a build

| Trigger | Result |
|---|---|
| push to `develop` | both platforms built, artifacts attached to the run (14 days) |
| push a `v*` tag | both platforms built, a GitHub Release is created |
| Actions → Run workflow | both platforms built on demand |

Development builds are downloaded from the run's **Artifacts** section. Releases
appear under **Releases** with the installers attached.

## Cutting a release

Versions come from the tag, so the tag is the single source of truth:

```bash
git tag v1.12.26
git push origin v1.12.26
```

`electron-builder.ts` reads `$VERSION`, which the workflow sets from the tag with
the leading `v` stripped. Nothing needs committing to bump a version.

Two rules for choosing the number:

- **Use plain semver** — `1.12.26`, not `1.12.26-eledrone.1`. Prerelease
  suffixes break MSI generation, which requires a purely numeric version.
- **Only ever go up.** The base version in `apps/desktop/package.json` is
  inherited from upstream Element (currently `1.12.25`), and Squirrel decides
  whether an installed app should upgrade by comparing versions. Tag `v1.12.26`
  or higher; a lower number will not be offered as an upgrade to anyone already
  running a newer build.

Builds from `develop` deliberately do **not** override the version — they carry
the `package.json` version so that MSI generation keeps working. Tell development
builds apart by the run number and commit in the artifact name, not the version.

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

The fork carries ~40 workflows from element-web, 15 of which trigger on a push to
`develop`. They expect Element's secrets (Netlify, Localazy, Docker Hub, npm) and
will fail. They are harmless but noisy; disable the unwanted ones individually
under Actions, or delete the workflow files.
