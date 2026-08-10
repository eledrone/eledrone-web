# CI status and open problem

Last updated 2026-08-11. Delete this file once the Vitest problem below is
resolved; it is a handover note, not permanent documentation.

## Where things stand

| Workflow                  | State                                       |
| ------------------------- | ------------------------------------------- |
| `eledrone desktop`        | green — builds Windows and Linux installers |
| `Static Analysis`         | green                                       |
| `Tests` → Jest (3 shards) | green                                       |
| `Tests` → Vitest          | **failing, see below**                      |

Everything related to the eledrone rebrand is finished: the ~109 snapshots and
~18 assertions that contained the brand name are updated, and class names and
test timezone are now platform-independent.

## The open problem: Vitest worker crash

The Vitest job does **not** fail on an assertion. It crashes:

```
✓  element-web  src/vector/init.test.ts (4 tests) 190ms
...
Error: process.exit unexpectedly called with "1"
    at process.workerOnGlobalUncaughtException [as _fatalException]

ReferenceError: window is not defined
    at react-dom-client.development.js:17920
    at Immediate.performWorkUntilDeadline (scheduler.development.js:45)

Node.js v24.18.0
```

Reading: `init.test.ts` finishes and passes. Vitest then tears down the
happy-dom window for that file, which aborts pending fetches. A React scheduler
callback that was still queued fires afterwards, touches `window`, and throws.
The throw is uncaught inside the worker, so the worker exits non-zero and takes
the job with it.

That is why the GitHub check shows only `Process completed with exit code 1`
with no per-test annotations — no test failed.

### What is known

- **Not caused by the rebrand.** Every brand assertion is fixed and Jest, which
  covers the same components, is green.
- **Does not reproduce on the Linux dev box.** A full `pnpm test:unit` there
  exits 1 only because of locale and Electron issues (below); no worker crash.
- **CI runs Node 24.18**; the dev box runs Node 22. The crash may be specific to
  Node 24, to CI timing, or simply be a race that happens to lose there.

### Things to try, cheapest first

1. **Re-run the Vitest job.** A teardown race is a strong flakiness candidate. If
   it passes on a re-run, decide whether to leave it or make it deterministic.
2. **Reproduce with CI's runtime**: `nvm install 24`, then
   `LC_ALL=C.UTF-8 pnpm test:unit`.
3. **Narrow it down**: run `src/vector/init.test.ts` alone, then with its
   neighbours, to see whether teardown order or a preceding file matters.
4. If it is genuinely an upstream flake, options are to isolate that file
   (`pool`/`isolate` settings, or its own project), or to park `tests.yml` until
   upstream fixes it — a permanently red check provides no signal.

## Running the tests locally

Three things bite when reproducing CI:

- **Go through `pnpm`, not the binaries.** `pnpm test` / `pnpm test:unit` run an
  nx prepare step that builds `@element-hq/element-web-module-api` first.
  Invoking `jest` directly fails all 511 suites with "Cannot find module".
- **Set the locale.** Several `Intl`-based tests assert English output, so on a
  non-English machine they fail with e.g. `expected 'сьогодні' to be 'today'`.
  Use `LC_ALL=C.UTF-8`.
- **Desktop suites need Electron.** `apps/desktop` tests fail to load entirely if
  `node_modules/electron` was never downloaded on that machine.

The timezone no longer needs setting by hand — both runners pin `TZ=UTC`
themselves, and CSS module class names are platform-independent, so snapshots
can be regenerated on any machine with `pnpm test:snapshots:update`.
