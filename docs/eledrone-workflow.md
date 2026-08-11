# The work pipeline

Start to finish for an ordinary change. Steps 1–9 are local; 10 onward is CI.

## 1. Sync first

```bash
git checkout develop && git pull
```

Do this before touching anything. Regenerating snapshots from a stale base is the one thing in
this repo that reliably produces conflicts.

## 2. Make the change

Prefer new files over edits to inherited ones. Anything that came from upstream and is modified
here has to be re-resolved on every sync, so a local change earns its place or it does not
happen. The changes that did earn it are listed in [MAINTAINING.md](MAINTAINING.md).

## 3. Write the test — in the right place

There are two runners, and the runner is chosen by **where the file lives and what it is
called**, not by a config you pick:

| Runner     | Path               | Filename         | Roughly |
| ---------- | ------------------ | ---------------- | ------- |
| **jest**   | `apps/web/test/**` | `Thing-test.tsx` | 511     |
| **vitest** | `apps/web/src/**`  | `Thing.test.tsx` | 223     |

Note the separator: jest uses a **dash**, vitest a **dot**. A file in the wrong place, or with
the wrong separator, is silently run by nobody — it does not fail, it simply never executes.

Other packages (`apps/desktop`, `modules/*`, `packages/*`) are vitest, colocated in `src/`.

**You never write the same test twice.** Two runners exist because upstream is mid-migration
from jest to vitest — it went from 616 jest / 7 vitest files in September 2025 to 511 / 223 by
August 2026, via commits like _"Migrate more tests to vitest"_. jest is the legacy suite,
shrinking; vitest is the destination.

So: a **new test file** goes in vitest, colocated in `src/`. An **existing** test stays in
whichever runner it is already in — porting it as a side-effect of an unrelated change turns a
small diff into a large one, and collides with upstream migrating that same file itself. Adding
a case to an existing jest suite means adding it to that file, in jest; do not split one suite
across two runners.

Vitest defaults to `environment: "node"`, so a test touching the DOM has to opt in on its first
line, or it fails with `document is not defined`:

```ts
// @vitest-environment happy-dom
```

Note the two runners use different DOM implementations — jsdom for jest, happy-dom for vitest —
and they differ at the edges. If something genuinely will not work under happy-dom, writing that
one in jest is a fair call.

Step 6 runs both suites for **coverage**, not authorship: existing tests are split across the
two, so a shared component can break the one you did not run.

## 4. Run just your test

```bash
# vitest — path, and -t to narrow to one case
corepack pnpm exec vitest run apps/web/src/path/Thing.test.tsx
corepack pnpm exec vitest run apps/web/src/path/Thing.test.tsx -t "does the thing"

# jest — filter by pattern, not by bare path
corepack pnpm --filter element-web run test --testPathPatterns Thing
```

A bare path fails with jest: it goes through Nx, which reads the first positional as a project
name and reports `Cannot find project '...'`. Use `--testPathPatterns`.

## 5. Update snapshots, if the UI changed

```bash
corepack pnpm run test:snapshots:update      # both runners
```

Safe on any platform. Then **read the diff** — see step 8.

## 6. Run the suites you affected

```bash
corepack pnpm --filter element-web run test      # jest,   ~4 min
corepack pnpm run test:unit                      # vitest, ~6 min
```

Running one proves nothing about the other; they cover different files. A shared component can
easily break only the suite you did not run.

Some failures are environmental and expected — check the list in
[eledrone-releases.md](eledrone-releases.md#regenerating-snapshots) before assuming you caused
them.

## 7. Types and lint

```bash
corepack pnpm -r --workspace-concurrency=1 lint:types
corepack pnpm lint:js
```

`pnpm lint` runs everything including `lint:fmt`, which on Windows reports every file as
misformatted because the working tree is CRLF. If you edited a Markdown or config file, check
its formatting the LF way — the workaround is in [CLAUDE.md](../CLAUDE.md).

## 8. Read the diff before committing

```bash
git diff --stat
git diff -U0 | grep -E "^[+-]" | grep -v "^[+-][+-]" | grep -viE "<what you meant to change>"
```

The second one should print nothing. Anything it does print is a change you did not intend —
usually a snapshot that moved because the environment differs from CI, which is worth
understanding before it lands rather than after CI goes red.

## 9. Commit

Prefix with the area — `feat:`, `fix:`, `test:`, `docs:`, `ci:`, `build:`. Subject in lower
case, then a body explaining **why**, since the diff already shows what:

```
ci: ship only the MSI for Windows

The Windows artifact carried both installers for the same app - a 143MB MSI
and a 181MB Squirrel .exe - and an artifact downloads as a single zip, so
getting either one meant transferring both.
```

## 10. Push and watch CI

```bash
git push origin develop
```

Three checks run: **Tests** (jest in 3 shards, plus vitest), **Static Analysis** (lint and
types), and **eledrone desktop** (builds Windows and Linux, and attaches the installers to the
run for 14 days — Windows ships the MSI only).

If something goes red, read [eledrone-ci-status.md](eledrone-ci-status.md) first — if that file
exists, it describes a problem already known and being tracked, and it may be yours.

## 11. Release, when you want one out

Only `main` publishes. Bump the version on `develop`, then fast-forward `main` — the full recipe
and the two rules for choosing a version number are in
[eledrone-releases.md](eledrone-releases.md#cutting-a-release).
