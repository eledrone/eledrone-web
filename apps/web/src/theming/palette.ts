/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

/**
 * The colour switcher: recolouring Compound's palette from a colour the user
 * picked, without touching its lightness.
 *
 * Compound builds every semantic colour out of a handful of base ramps. The
 * accent - buttons, links, the call panel's connected state, the unread dot -
 * is the green ramp, and the app's surfaces are the grey one. Recolouring
 * those two ramps therefore recolours the app, and nothing has to know which
 * of the hundreds of semantic tokens it is behind.
 *
 * The ramps below are Compound's own colours converted to OKLCH, with the hue
 * thrown away because that is the part being replaced. Keeping each step's
 * measured lightness is the whole trick: text that was readable on a green
 * button is equally readable on a pink one, because in OKLCH the L of a colour
 * is what the eye reads as its lightness. Change the hue and the contrast
 * ratios come along unchanged; regenerate the ramp by hand and they do not.
 */

/** A step of a ramp: its number, lightness, chroma, and alpha where it has one. */
type RampStep = [step: number, lightness: number, chroma: number, alpha?: number];

interface Ramps {
    light: RampStep[];
    dark: RampStep[];
}

/**
 * `--cpd-color-green-*`, which every accent token resolves to.
 *
 * Measured from `cpd-theme-{light,dark}-base.css` in
 * `@vector-im/compound-design-tokens`. If Compound reworks its palette these
 * drift out of date - the symptom is a recoloured app whose accent is a
 * slightly different shade from the built-in one, never a broken one.
 */
const ACCENT_RAMP: Ramps = {
    light: [
        [100, 0.9897, 0.0059],
        [200, 0.9792, 0.0124],
        [300, 0.9587, 0.0248],
        [400, 0.9155, 0.0488],
        [500, 0.8528, 0.0858],
        [600, 0.8061, 0.1134],
        [700, 0.728, 0.1498],
        [800, 0.613, 0.122],
        [900, 0.5162, 0.1002],
        [1000, 0.4693, 0.0934],
        [1100, 0.4218, 0.0849],
        [1200, 0.3592, 0.0753],
        [1300, 0.2871, 0.0638],
        [1400, 0.2253, 0.054],
    ],
    dark: [
        [100, 0.1988, 0.0496],
        [200, 0.2104, 0.051],
        [300, 0.2329, 0.0549],
        [400, 0.2658, 0.06],
        [500, 0.3187, 0.0679],
        [600, 0.3559, 0.0749],
        [700, 0.4153, 0.084],
        [800, 0.5165, 0.0995],
        [900, 0.6118, 0.1184],
        [1000, 0.6632, 0.1299],
        [1100, 0.7192, 0.1429],
        [1200, 0.8017, 0.11],
        [1300, 0.8892, 0.0613],
        [1400, 0.9439, 0.0331],
    ],
};

/**
 * `--cpd-color-alpha-green-*`: the same ramp as translucent overlays, used for
 * things tinted over whatever is behind them - a selected room, a hovered
 * accent button. Left out, the accent changes colour but its selection
 * highlights stay green.
 */
const ACCENT_ALPHA_RAMP: Ramps = {
    light: [
        [100, 0.7002, 0.1578, 0.03],
        [200, 0.697, 0.1726, 0.06],
        [300, 0.684, 0.1819, 0.11],
        [400, 0.6812, 0.1746, 0.23],
        [500, 0.6902, 0.1701, 0.41],
        [600, 0.6848, 0.1644, 0.56],
        [700, 0.7177, 0.1521, 0.96],
        [800, 0.6069, 0.1217],
        [900, 0.5176, 0.1],
        [1000, 0.4696, 0.0934],
        [1100, 0.4212, 0.0848],
        [1200, 0.354, 0.074],
        [1300, 0.2836, 0.0629],
        [1400, 0.2279, 0.0548],
    ],
    dark: [
        [100, 0.2085, 0.0525],
        [200, 0.2089, 0.0506],
        [300, 0.2282, 0.0534],
        [400, 0.2654, 0.0601],
        [500, 0.3193, 0.0684],
        [600, 0.354, 0.074],
        [700, 0.4212, 0.0848],
        [800, 0.5176, 0.1],
        [900, 0.8816, 0.1798, 0.58],
        [1000, 0.8851, 0.1806, 0.65],
        [1100, 0.8832, 0.1787, 0.74],
        [1200, 0.912, 0.1279, 0.83],
        [1300, 0.9476, 0.0678, 0.91],
        [1400, 0.9716, 0.0326, 0.96],
    ],
};

/**
 * `--cpd-color-gray-*`, which is what the app's surfaces and its text are made
 * of. Its own chroma is close to zero, so unlike the accent this ramp is not
 * scaled from what it was - it is given a chroma outright, which is what turns
 * grey into charcoal-with-a-colour-in-it.
 */
const SURFACE_RAMP: Ramps = {
    light: [
        [100, 0.9906, 0.0017],
        [200, 0.9809, 0.0025],
        [300, 0.9605, 0.0046],
        [400, 0.9229, 0.0098],
        [500, 0.8643, 0.0117],
        [600, 0.8173, 0.0136],
        [700, 0.7452, 0.0164],
        [800, 0.6297, 0.0196],
        [900, 0.5314, 0.0185],
        [1000, 0.4807, 0.0158],
        [1100, 0.433, 0.0132],
        [1200, 0.3696, 0.0101],
        [1300, 0.2972, 0.0095],
        [1400, 0.2308, 0.0101],
    ],
    dark: [
        [100, 0.2032, 0.0093],
        [200, 0.2179, 0.0103],
        [300, 0.2393, 0.01],
        [400, 0.2769, 0.0096],
        [500, 0.3276, 0.0082],
        [600, 0.3667, 0.0095],
        [700, 0.4252, 0.0119],
        [800, 0.5287, 0.0179],
        [900, 0.6263, 0.0196],
        [1000, 0.68, 0.0186],
        [1100, 0.7356, 0.0165],
        [1200, 0.8152, 0.0143],
        [1300, 0.8985, 0.0098],
        [1400, 0.948, 0.0063],
    ],
};

/** `--cpd-color-theme-bg`: the canvas everything else sits on. */
const CANVAS_LIGHTNESS = { light: 1, dark: 0.1853 };

/**
 * The chroma a fully saturated accent is expected to have, near the peak of
 * Compound's own ramp. A picked colour is measured against this, so choosing
 * something about as vivid as the built-in green reproduces the built-in
 * ramp's intensity in a different hue.
 */
const REFERENCE_CHROMA = 0.15;

/**
 * How far past Compound's own saturation a pick may push the ramp. Beyond
 * roughly this the brighter steps leave the sRGB gamut, and a browser
 * resolving that by clipping shifts the hue - so the ramp would stop being the
 * colour that was asked for.
 */
const MAX_ACCENT_SCALE = 1.25;

/**
 * The ceiling on a surface tint. Backgrounds carry the app's text, and past
 * about this much colour a tint stops reading as a tint and starts eating
 * contrast, so a vivid pick gives a strong tint rather than an unusable one.
 */
const MAX_SURFACE_CHROMA = 0.04;

export interface Oklch {
    /** Perceptual lightness, 0 to 1. */
    l: number;
    /** Chroma - how much colour there is. 0 is grey; sRGB rarely exceeds 0.37. */
    c: number;
    /** Hue angle in degrees. */
    h: number;
}

function srgbToLinear(channel: number): number {
    return channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

/**
 * Converts an `#rrggbb` colour - what an `<input type="color">` produces - to
 * OKLCH, or null if it is not one.
 */
export function parseHexColour(hex: string): Oklch | null {
    const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) return null;

    const [r, g, b] = [0, 2, 4].map((i) => srgbToLinear(parseInt(match[1].slice(i, i + 2), 16) / 255));

    // sRGB to OKLab, via the LMS cone responses. The matrices are Björn
    // Ottosson's, from the OKLab reference implementation.
    const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    const l = 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short;
    const a = 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short;
    const b2 = 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short;

    const h = (Math.atan2(b2, a) * 180) / Math.PI;
    return { l, c: Math.hypot(a, b2), h: h < 0 ? h + 360 : h };
}

const round = (value: number, places: number): number => Number(value.toFixed(places));

function oklch(lightness: number, chroma: number, hue: number, alpha?: number): string {
    const colour = `oklch(${round(lightness, 4)} ${round(chroma, 4)} ${round(hue, 2)}`;
    return alpha === undefined ? `${colour})` : `${colour} / ${alpha})`;
}

/** One ramp's worth of declarations, at the given hue and whatever chroma the caller wants per step. */
function rampCss(prefix: string, steps: RampStep[], hue: number, chromaFor: (chroma: number) => number): string {
    return steps
        .map(
            ([step, lightness, chroma, alpha]) =>
                `${prefix}${step}: ${oklch(lightness, chromaFor(chroma), hue, alpha)};`,
        )
        .join(" ");
}

function declarationsFor(theme: "light" | "dark", accent: Oklch | null, surface: Oklch | null): string {
    const declarations: string[] = [];

    if (accent) {
        // The ramp keeps its shape and is scaled bodily, so its pale steps stay
        // pale and its vivid ones stay vivid relative to each other.
        const scale = Math.min(accent.c / REFERENCE_CHROMA, MAX_ACCENT_SCALE);
        declarations.push(rampCss("--cpd-color-green-", ACCENT_RAMP[theme], accent.h, (chroma) => chroma * scale));
        declarations.push(
            rampCss("--cpd-color-alpha-green-", ACCENT_ALPHA_RAMP[theme], accent.h, (chroma) => chroma * scale),
        );
    }

    if (surface) {
        // A flat chroma across the ramp, since the greys have none of their own
        // to scale: what varies from step to step is lightness, and that stays.
        const chroma = Math.min(surface.c, MAX_SURFACE_CHROMA);
        declarations.push(`--cpd-color-theme-bg: ${oklch(CANVAS_LIGHTNESS[theme], chroma, surface.h)};`);
        declarations.push(rampCss("--cpd-color-gray-", SURFACE_RAMP[theme], surface.h, () => chroma));
    }

    return declarations.join(" ");
}

/**
 * A stylesheet recolouring Compound's ramps, or the empty string if neither
 * colour was chosen.
 *
 * It goes in the `compound-tokens` layer, the same one the design tokens
 * themselves are imported into, so it overrides them by source order without
 * outranking anything else. That is what keeps it underneath the user's own
 * CSS: a stylesheet from the themes folder is unlayered, and unlayered rules
 * beat layered ones no matter what order they arrive in.
 *
 * The selectors are doubled because Compound's are - it ships
 * `.cpd-theme-dark.cpd-theme-dark` - so this has to match that specificity to
 * be allowed to win on order. Both themes are written out at once and the
 * class on `<body>` picks between them, so nothing here has to be regenerated
 * when the user switches between light and dark.
 *
 * High contrast is deliberately left alone: its ramps are built for a contrast
 * floor that a recolouring cannot promise to keep.
 *
 * @param accentHex the accent colour as `#rrggbb`, or null to leave it alone
 * @param surfaceHex the background tint as `#rrggbb`, or null to leave it alone
 */
export function generatePaletteCss(accentHex: string | null, surfaceHex: string | null): string {
    const accent = accentHex ? parseHexColour(accentHex) : null;
    const surface = surfaceHex ? parseHexColour(surfaceHex) : null;
    if (!accent && !surface) return "";

    const rules = (["light", "dark"] as const)
        .map((theme) => `.cpd-theme-${theme}.cpd-theme-${theme} { ${declarationsFor(theme, accent, surface)} }`)
        .join("\n");

    return `@layer compound-tokens {\n${rules}\n}`;
}
