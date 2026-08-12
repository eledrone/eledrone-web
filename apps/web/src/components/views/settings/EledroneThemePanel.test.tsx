/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { fireEvent, render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EledroneThemePanel } from "./EledroneThemePanel";
import { EledroneThemeStore } from "../../../theming/EledroneThemeStore";
import { type CssThemeListing, type CssThemeSource } from "../../../theming/CssThemeSource";
import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import PlatformPeg from "../../../PlatformPeg";
import type BasePlatform from "../../../BasePlatform";

const store = EledroneThemeStore.instance;

/** A themes folder, as the desktop platform would provide one. */
const fakeSource = (themes: Record<string, string>): CssThemeSource & { revealed: () => number } => {
    let revealed = 0;
    return {
        canReveal: true,
        revealed: () => revealed,
        list: async (): Promise<CssThemeListing> => ({
            directory: "/home/someone/.config/eledrone/themes",
            themes: Object.entries(themes).map(([fileName, css]) => ({ fileName, css })),
        }),
        write: async (fileName, css) => void (themes[fileName] = css),
        remove: async (fileName) => void delete themes[fileName],
        reveal: async () => void revealed++,
        watch: () => () => {},
    };
};

async function startWith(source: CssThemeSource): Promise<void> {
    vi.spyOn(PlatformPeg, "get").mockReturnValue({
        getCssThemeSource: () => source,
    } as unknown as BasePlatform);
    await store.start();
}

describe("<EledroneThemePanel />", () => {
    beforeEach(async () => {
        await SettingsStore.setValue("eledroneCssThemes", null, SettingLevel.DEVICE, []);
        await SettingsStore.setValue("eledroneAccentColour", null, SettingLevel.DEVICE, null);
        await SettingsStore.setValue("eledroneSurfaceColour", null, SettingLevel.DEVICE, null);
    });

    afterEach(() => {
        store.stop();
        vi.restoreAllMocks();
        for (const style of document.querySelectorAll("style[data-eledrone-css-theme], style[data-eledrone-palette]")) {
            style.remove();
        }
    });

    it("says where the stylesheets live, and offers to show them", async () => {
        const source = fakeSource({ "pink.css": "a {}" });
        await startWith(source);
        render(<EledroneThemePanel />);

        expect(screen.getByText(/\/home\/someone\/\.config\/eledrone\/themes/)).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
        expect(source.revealed()).toBe(1);
    });

    it("lists the stylesheets and applies the one that is switched on", async () => {
        await startWith(fakeSource({ "pink.css": ":root { --thing: pink; }" }));
        render(<EledroneThemePanel />);

        await userEvent.click(screen.getByRole("switch", { name: "pink.css" }));

        await waitFor(() => expect(store.enabledThemeNames).toEqual(["pink.css"]));
        expect(document.querySelector("style[data-eledrone-css-theme='pink.css']")).toBeInTheDocument();
    });

    it("deletes a stylesheet", async () => {
        await startWith(fakeSource({ "pink.css": "a {}" }));
        render(<EledroneThemePanel />);

        await userEvent.click(screen.getByRole("button", { name: "Delete" }));

        await waitFor(() => expect(screen.queryByText("pink.css")).not.toBeInTheDocument());
    });

    it("says so when there is nothing to list", async () => {
        await startWith(fakeSource({}));
        render(<EledroneThemePanel />);

        expect(screen.getByText("No stylesheets yet.")).toBeInTheDocument();
    });

    it("changes the accent colour", async () => {
        await startWith(fakeSource({}));
        const { container } = render(<EledroneThemePanel />);

        const swatch = container.querySelector<HTMLInputElement>(".mx_EledroneThemePanel_swatch")!;
        // A colour input cannot be typed into, so this is what the picker does
        fireEvent.change(swatch, { target: { value: "#ff4fa3" } });

        await waitFor(() => expect(SettingsStore.getValue("eledroneAccentColour")).toBe("#ff4fa3"));
        expect(document.querySelector("style[data-eledrone-palette]")?.textContent).toContain("--cpd-color-green-900:");
    });

    it("leaves the colours pickable while a stylesheet is applied", async () => {
        // A theme overrides the colours it sets and no others, so taking the
        // pickers away would strand every token the theme does not mention.
        await SettingsStore.setValue("eledroneCssThemes", null, SettingLevel.DEVICE, ["pink.css"]);
        await startWith(fakeSource({ "pink.css": ":root { --thing: pink; }" }));
        const { container } = render(<EledroneThemePanel />);

        for (const swatch of document.querySelectorAll<HTMLInputElement>(".mx_EledroneThemePanel_swatch")) {
            expect(swatch).toBeEnabled();
        }

        const swatch = container.querySelector<HTMLInputElement>(".mx_EledroneThemePanel_swatch")!;
        fireEvent.change(swatch, { target: { value: "#ff4fa3" } });

        await waitFor(() =>
            expect(document.querySelector("style[data-eledrone-palette]")?.textContent).toContain(
                "--cpd-color-green-900:",
            ),
        );
        expect(document.querySelector("style[data-eledrone-css-theme]")?.textContent).toContain("--thing: pink");
    });
});
