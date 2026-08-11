# Working on eledrone-web

A fork of [element-hq/element-web](https://github.com/element-hq/element-web) carrying local
changes on top of upstream. This page is the orientation; the deeper docs are linked at the
bottom. Written for anyone new to the repo, human or agent.

**Doing a change start to finish?** Follow
[the work pipeline](docs/eledrone-workflow.md) — sync, code, test, snapshots, lint, commit, CI.
This page is the reference behind it.

## Ground rules

- **`develop` is the trunk.** Everything lands there. Upstream is _merged_, never rebased, so
  history stays valid for anything already built or installed.
- **Pull before you start.** Two people regenerating snapshots from different bases is a merge
  conflict you did not need.
- **Prefer not to edit inherited files.** Anything that came from upstream and is edited here
  becomes a conflict on every sync. Where a local change is genuinely required it is listed in
  [MAINTAINING.md](docs/MAINTAINING.md); keep that list short.
- **Use `corepack pnpm`, not a global one.** The version is pinned (`devEngines`, currently
  11.20.0), and argument handling differs between majors — see the note under Commands.

## Commands

| Task               | Command                                       |
| ------------------ | --------------------------------------------- |
| Install            | `corepack pnpm install`                       |
| Jest (apps/web)    | `corepack pnpm --filter element-web run test` |
| Vitest (root)      | `corepack pnpm run test:unit`                 |
| Both, update snaps | `corepack pnpm run test:snapshots:update`     |
| Lint everything    | `corepack pnpm lint`                          |
| Format             | `corepack pnpm lint:fmt` / `lint:fmt:fix`     |

**Go through the pnpm scripts, not the binaries.** They run an Nx prepare step that builds
`@element-hq/element-web-module-api` first. Calling `jest` directly fails all 511 suites with
"Cannot find module".

There are two test runners and they cover different suites — running one proves nothing about
the other.

**Do not write `pnpm run <script> -- <flag>`.** pnpm 11 forwards the `--` through as a literal
argument, so the script receives `"--" "-u"` and the flag is quietly ignored — no error, it just
does not do what you asked. Pass flags directly: `pnpm run test:unit -u`.

## Testing

Snapshots regenerate identically on any platform, so `pnpm test:snapshots:update` is safe
wherever you are. Read the diff before committing: a snapshot moving for a reason you cannot
name means the environment differs from CI, not that the snapshot was stale.

Some tests fail locally for environmental reasons and are expected to — the current list, with
the reason for each, is in [eledrone-releases.md](docs/eledrone-releases.md#regenerating-snapshots).
Check there before assuming you broke something.

**Changing `brand`** in `apps/web/src/SdkConfig.ts` breaks roughly 110 snapshots and a dozen
assertions, because it is rendered into user-visible strings that tests hardcode. That is
expected; regenerate and read the diff.

## Two traps that cost real time

**Nx caches builds, and a config file that is not in `inputs` does not invalidate the cache.**
Change `vite.config.ts`, rebuild, and Nx replays a stale `dist/` — the change appears to do
nothing at all, with no error. If a build config edit seems inert, check the target's `inputs`
in that package's `project.json` before debugging the config itself.

**`oxfmt` formats Markdown too**, so editing a `.md` file can fail Static Analysis. On Windows
you cannot check this directly: the working tree is CRLF, so `lint:fmt` reports _every_ file as
misformatted and buries the one real complaint. Check the LF content instead:

```bash
mkdir -p .fmtcheck && tr -d '\r' < docs/thing.md > .fmtcheck/thing.md
corepack pnpm exec oxfmt --check .fmtcheck/thing.md; rm -rf .fmtcheck
```

A common cause: a paragraph continuing a list item needs **four** spaces of indent, not two.

## Where to read more

| Document                                            | Covers                                                     |
| --------------------------------------------------- | ---------------------------------------------------------- |
| [eledrone-workflow.md](docs/eledrone-workflow.md)   | the work pipeline, step by step — start here               |
| [MAINTAINING.md](docs/MAINTAINING.md)               | fork layout, syncing upstream, local builds, audio gotchas |
| [eledrone-releases.md](docs/eledrone-releases.md)   | CI workflows, cutting a release, snapshots, known failures |
| [eledrone-ci-status.md](docs/eledrone-ci-status.md) | whatever is currently broken on CI — a handover note       |

`eledrone-ci-status.md` is temporary by design. If it still exists, read it: it describes an
open problem. Delete it when that problem is gone.
