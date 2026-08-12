# Themes

Two ways for a user to change how the app looks, and one rule between them.

**CSS themes** are stylesheets the user wrote or downloaded, kept in a folder on desktop and in
browser storage on the web. They are applied verbatim and can restyle anything.

**The colour switcher** is two colour pickers - an accent and a background tint - which recolour
Compound's palette. It sits underneath: both are always written out, and a theme overrides the
picked colours only for the tokens it actually sets.

Neither replaces Element's light and dark. A CSS theme is written against one of them, and the
switcher recolours both at once.

This note is the reasoning behind the local changes listed in [MAINTAINING.md](MAINTAINING.md).

## The folder

On desktop the themes live in `themes/` inside the user data directory - so on Windows,
`%APPDATA%\Eledrone\themes`, and under `~/.config/eledrone/themes` on Linux. Settings → Appearance
has a button that opens it.

The main process owns the folder. It lists, reads, writes and deletes on request
(`apps/desktop/src/themes.ts`, reachable over the four `ipcCall` names `getThemes`, `writeTheme`,
`deleteTheme` and `openThemesDirectory`), and it watches the folder with `fs.watch`, sending
`themesChanged` when anything moves. The renderer holds no copy: it re-reads the lot whenever it is
told something changed, so the folder is always the truth about which themes exist.

Saving a file therefore re-applies it in the running app. That is the point of the folder existing -
the edit loop is save-and-look, not save-and-restart.

Two details worth knowing. The watcher debounces for 150ms, because an editor saving a file produces
two or three events and each one would otherwise be a reload. And file names arriving from the
renderer are refused rather than sanitised unless they are a plain `.css` name: no separators, no
parent references, no other extension. A bug in the renderer cannot then write somewhere else.

In a browser there is no folder, so imported stylesheets are kept in local storage under
`mx_eledrone_css_themes`, capped at 2MB in total. Device-local on purpose: a stylesheet is code that
runs against the app's markup, and pushing one to every device from a browser tab is a bigger promise
than this feature makes. Everything above `CssThemeSource` is the same either way.

## Why a CSS theme always wins

Element's own CSS is layered - `compound-tokens`, `compound-web`, `shared-components`, `app-web`, in
that order - and the design tokens are imported into the first of them.

The colour switcher's stylesheet goes into `compound-tokens` too, matching Compound's own doubled
selector (`.cpd-theme-dark.cpd-theme-dark`) so it can win on source order without outranking
anything else. Both themes are written out at once and the class on `<body>` picks between them,
which is why nothing has to be regenerated when the user switches light to dark.

A CSS theme is injected **unlayered**, at the end of `<head>`. Unlayered rules beat every layer
regardless of order, so a theme outranks the switcher, the design tokens, and the app's own styles
without having to fight any of them on specificity.

That is the whole of the rule: the two are not exclusive, and the cascade settles every token
separately. A theme that only restyles the composer leaves the rest of the app in the colours the
user picked, and the pickers stay usable while a theme is applied rather than going inert - taking
them away would strand every token the theme never mentions. A name left in the enabled list whose
file has since been deleted counts as no theme, so its colours simply stop being overridden.

## The call view

The call is Element Call in a widget iframe, and styles do not cross that boundary, so both
mechanisms are written into the widget's document as well as the app's own. It works because
Element Call puts the same `cpd-theme-dark` class on its own `<body>` and is built from the same
design tokens: the same stylesheet means the same thing there. The palette's `compound-tokens` layer
does not exist inside Element Call, so it is created last in that document's layer order and
therefore outranks Element Call's own `cpd-base` and `cpd-semantic` layers.

Only token overrides carry across. `.mx_*` selectors are this app's markup and match nothing inside
a widget. Reaching in at all depends on the widget being same-origin, which the embedded copy is;
one served from somewhere else - `Developer.elementCallUrl` pointed at a deployment - is another
origin and is left alone. A widget that reloads is written into again on its `load`.

## What the colour switcher actually does

Compound builds every semantic colour out of a few base ramps. The accent - buttons, links, the
unread dot, the call panel's connected state - is the green ramp, and the app's surfaces and text are
the grey one. Recolour those and the app is recoloured, without anything having to know which of the
hundreds of semantic tokens sit on top.

`apps/web/src/theming/palette.ts` holds Compound's own ramps converted to OKLCH, with the hue thrown
away because that is the part being replaced. Keeping each step's measured **lightness** is the whole
trick: in OKLCH the L of a colour is what the eye reads as its lightness, so text that was readable
on a green button is equally readable on a pink one. Regenerating a ramp by hand instead is how forks
end up with unreadable buttons.

- The **accent** takes the picked hue, and the ramp's chroma is scaled by how vivid the pick is
  against Compound's own accent. The scale is capped at 1.25, past which the brighter steps leave the
  sRGB gamut and a browser clipping them shifts the hue away from what was asked for.
- The **background tint** takes the picked hue at a flat chroma, capped at 0.04, because the greys
  have no chroma of their own to scale and a background carries the app's text. Past about that much
  colour a tint stops reading as a tint and starts eating contrast.
- The alpha green ramp is recoloured with the accent - it is what selection highlights are made of,
  and left out they would stay green under a pink accent. The alpha grey ramp is left alone: those
  are overlays whose colour barely reads, and mis-tinting a 90%-opaque one costs contrast for nothing.
- High contrast is left alone entirely. Its ramps are built for a contrast floor that a recolouring
  cannot promise to keep.

The tables were measured from `@vector-im/compound-design-tokens`. If Compound reworks its palette
they drift: the symptom is a recoloured app whose accent is a slightly different shade from the
built-in one, never a broken one.

## Writing a theme

A theme is ordinary CSS. The productive target is the design tokens rather than class names, since
those are stable and cover the whole app at once:

```css
.cpd-theme-dark.cpd-theme-dark {
    --cpd-color-theme-bg: #17151a;
    --cpd-color-gray-100: #1c191f;
    /* the accent, which everything from buttons to the unread dot resolves to */
    --cpd-color-green-900: #d95d9a;
    --cpd-color-green-1000: #e06ea6;
}
```

The full token list is in the [Compound docs](https://compound.element.io/?path=/docs/tokens-semantic-colors--docs),
and the ramps themselves are in `@vector-im/compound-design-tokens/assets/web/css/`. Note the doubled
class selector: Compound ships its own that way, so a single class loses on specificity.

Class names work too - `.mx_RoomTile`, `.mx_CallPanel` and so on - but they are Element's internals
and change without notice. A theme leaning on them is a theme that needs maintaining.

Several themes can be applied at once. They are ordered by when they were switched on, so a later one
overrides an earlier one.

## Where the code is

| File                                                    | Is                                                    |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `apps/desktop/src/themes.ts`                            | the folder: listing, writing, watching                |
| `apps/web/src/theming/CssThemeSource.ts`                | the interface, and the browser storage implementation |
| `apps/web/src/theming/ThemeStore.ts`                    | what is applied, and the rule about which wins        |
| `apps/web/src/theming/palette.ts`                       | the ramps and the colour maths                        |
| `apps/web/src/components/views/settings/ThemePanel.tsx` | the settings UI                                       |

The store is started from `loadTheme()` in `apps/web/src/vector/init.tsx`, straight after Element's
own theme is applied, so the window is painted in the user's colours the first time rather than
repainted into them a moment later.
