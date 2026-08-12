/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { describe, expect, it } from "vitest";

import { generatePaletteCss, parseHexColour } from "./palette";

const PINK = "#ff4fa3";

/** Every `oklch(l c h)` in the given CSS, as numbers. */
function colours(css: string): { lightness: number; chroma: number; hue: number }[] {
    return [...css.matchAll(/oklch\((-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({
        lightness: Number(match[1]),
        chroma: Number(match[2]),
        hue: Number(match[3]),
    }));
}

describe("parseHexColour", () => {
    it("reads a hex colour as OKLCH", () => {
        const white = parseHexColour("#ffffff")!;
        expect(white.l).toBeCloseTo(1, 3);
        expect(white.c).toBeCloseTo(0, 3);

        // Compound's own accent, which the ramps were measured from
        const accent = parseHexColour("#0dbd8b")!;
        expect(accent.l).toBeCloseTo(0.7, 1);
        expect(accent.h).toBeGreaterThan(150);
        expect(accent.h).toBeLessThan(180);
    });

    it("refuses anything that is not a six digit hex colour", () => {
        for (const value of ["", "#fff", "red", "rgb(1,2,3)", "#gggggg", "#ff4fa3ff"]) {
            expect(parseHexColour(value)).toBeNull();
        }
    });
});

describe("generatePaletteCss", () => {
    it("writes nothing when no colour has been chosen", () => {
        expect(generatePaletteCss(null, null)).toBe("");
    });

    it("puts the overrides in Compound's own layer, at Compound's own specificity", () => {
        const css = generatePaletteCss(PINK, null);

        expect(css).toContain("@layer compound-tokens {");
        // Compound ships `.cpd-theme-dark.cpd-theme-dark`, so anything hoping
        // to override it by source order has to match that specificity.
        expect(css).toContain(".cpd-theme-light.cpd-theme-light {");
        expect(css).toContain(".cpd-theme-dark.cpd-theme-dark {");
    });

    it("recolours the accent ramp, and only the accent ramp", () => {
        const css = generatePaletteCss(PINK, null);

        expect(css).toContain("--cpd-color-green-900:");
        // The selection highlights are the alpha ramp; left out, they stay green
        expect(css).toContain("--cpd-color-alpha-green-300:");
        expect(css).not.toContain("--cpd-color-gray-");
        expect(css).not.toContain("--cpd-color-theme-bg");

        // One hue throughout, and it is the one that was picked
        const hues = new Set(colours(css).map((colour) => colour.hue));
        expect(hues.size).toBe(1);
        expect([...hues][0]).toBeCloseTo(parseHexColour(PINK)!.h, 1);
    });

    it("keeps each step's lightness, which is what keeps text on the accent readable", () => {
        const css = generatePaletteCss(PINK, null);
        const light = css.split(".cpd-theme-dark")[0];

        // The measured lightness of Compound's own green-900 in the light theme
        expect(light).toContain("--cpd-color-green-900: oklch(0.5162 ");
    });

    it("keeps a vivid pick inside the sRGB gamut by capping how far it scales", () => {
        // Both of these are far more saturated than Compound's accent, so both
        // land on the cap and produce the same chromas in different hues.
        const red = colours(generatePaletteCss("#ff0000", null)).map((colour) => colour.chroma);
        const blue = colours(generatePaletteCss("#0000ff", null)).map((colour) => colour.chroma);

        expect(red).toEqual(blue);
    });

    it("tints the surfaces gently, however strong the colour it is given", () => {
        const css = generatePaletteCss(null, "#ff0000");

        expect(css).toContain("--cpd-color-theme-bg:");
        expect(css).toContain("--cpd-color-gray-1400:");
        expect(css).not.toContain("--cpd-color-green-");

        // A background carries the app's text: past a little colour it stops
        // being a tint and starts eating contrast.
        for (const { chroma } of colours(css)) expect(chroma).toBeLessThanOrEqual(0.04);
    });

    it("keeps the canvas dark in dark and light in light", () => {
        const css = generatePaletteCss(null, "#ff4fa3");
        const [light, dark] = css.split(".cpd-theme-dark.cpd-theme-dark");

        expect(light).toContain("--cpd-color-theme-bg: oklch(1 ");
        expect(dark).toContain("--cpd-color-theme-bg: oklch(0.1853 ");
    });

    it("writes both colours when both are chosen", () => {
        const css = generatePaletteCss(PINK, "#202028");

        expect(css).toContain("--cpd-color-green-900:");
        expect(css).toContain("--cpd-color-gray-100:");
    });

    it("ignores a colour it cannot read", () => {
        expect(generatePaletteCss("not a colour", null)).toBe("");
    });
});
