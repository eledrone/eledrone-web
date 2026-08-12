# Where Element Call comes from

The app does not use the Element Call running at `call.gandon.pp.ua`. It embeds
its own copy, and until this change that copy was **upstream's**, no matter what
the fork said.

This note is the reasoning behind the local changes listed in
[MAINTAINING.md](MAINTAINING.md); delete it once they are upstream or no longer
needed.

## Two artifacts, one source

`eledrone-call` builds two different things from the same tree:

| Artifact                       | Built by                                       | Used by                               |
| ------------------------------ | ---------------------------------------------- | ------------------------------------- |
| A Docker image                 | `.github/workflows/eledrone-call.yml`          | the server behind `call.gandon.pp.ua` |
| An npm package, `embedded/web` | `.github/workflows/eledrone-call-embedded.yml` | this app, bundled into `webapp/`      |

Only the first existed for a long time, which is why the fork was deployed and
yet none of it reached anybody: the widget in the desktop and web apps is the npm
package, and that came from the public registry.

The two have independent lifetimes. Upgrading the server does not upgrade the
widget, and vice versa. If a call misbehaves, the first question is which of them
you actually changed.

## How the widget gets here

`webpack.config.ts` copies `getPackageRoot("@element-hq/element-call-embedded")/dist`
into `webapp/widgets/element-call`, and `Call.ts` points the iframe at
`./widgets/element-call/index.html`. So anything resolvable with a `dist/` will
do — the dependency does not have to come from a registry.

It comes from a GitHub release instead:

```json
"@element-hq/element-call-embedded": "https://github.com/eledrone/eledrone-call/releases/download/embedded-<sha>/element-hq-element-call-embedded-0.0.0-eledrone.<sha>.tgz"
```

Both repositories are public, so this needs no credential in CI or on anyone's
machine. npm is not available - the package name belongs to Element - and GitHub
Packages would mean an `.npmrc` token everywhere the app is built. pnpm records
an integrity hash for the URL in the lockfile, so the artifact is pinned and
tamper-evident, not merely named.

## Upgrading it

Push to `main` on `eledrone-call`; the workflow publishes a release per commit,
tagged `embedded-<short-sha>`, and prints the line to paste. Change the URL here,
run `pnpm install`, commit both files. That commit is the record of which widget
this app ships - the same reasoning as pinning the server image by digest rather
than following a tag.

Editing the widget workflow does **not** redeploy the server: it is in
`eledrone-call.yml`'s `paths-ignore`. Editing anything else there still does.

## Which build am I looking at?

`VITE_APP_VERSION` carries the short sha, so Element Call announces itself on
startup:

```
Element Call embedded-eledrone-f12defc
```

`embedded-v0.22.0` instead means the app is still on upstream's package. Telling
those apart has already cost an afternoon once.

## The cost

Syncing upstream now means resolving conflicts in two repositories rather than
one. That is the price of being able to change Element Call at all — deafen,
screen share and the connection indicator all need actions it does not currently
have — but it is a real price, and it is worth keeping the fork's own changes to
Element Call as small as the ones here.

Sourcemaps ship with the widget, including `sourcesContent`, so its real
TypeScript is readable in `dist/assets/*.js.map`. That is how the hangup
behaviour described in [call-hangup.md](call-hangup.md) was worked out, and it is
usually faster than reasoning from our side of the widget API.
