/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type ChangeEvent, type JSX, useCallback, useRef, useState } from "react";
import { Button, IconButton, InlineField, Label, Root, ToggleControl } from "@vector-im/compound-web";
import DeleteIcon from "@vector-im/compound-design-tokens/assets/web/icons/delete";
import FolderIcon from "@vector-im/compound-design-tokens/assets/web/icons/folder";

import { _t } from "../../../languageHandler";
import { SettingsSubsection } from "./shared/SettingsSubsection";
import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import { useSettingValue } from "../../../hooks/useSettings";
import { useEventEmitterState } from "../../../hooks/useEventEmitter";
import { ThemeEvent, ThemeStore } from "../../../theming/ThemeStore";

/** Compound's own accent, which is what "nothing chosen" looks like in the picker. */
const DEFAULT_ACCENT = "#0dbd8b";
/** The dark theme's canvas, as a starting point for a background tint. */
const DEFAULT_SURFACE = "#101317";

/**
 * The fork's theming settings: the user's own CSS themes, and the colour
 * switcher underneath them. Both stay usable at once - a theme overrides the
 * picked colours only for the tokens it actually sets.
 *
 * Sits below the light/dark chooser rather than replacing it, because it does
 * not replace it - a CSS theme is written against one or the other.
 */
export function ThemePanel(): JSX.Element {
    return (
        <>
            <CssThemes />
            <PaletteColours />
        </>
    );
}

/** Re-renders whenever the set of themes changes, and hands back the store. */
function useThemeStore(): ThemeStore {
    const store = ThemeStore.instance;
    // The value is the themes themselves: a new array each time, so a file
    // saved in the folder repaints this list.
    useEventEmitterState(store, ThemeEvent.Update, () => store.themes);
    return store;
}

function CssThemes(): JSX.Element {
    const store = useThemeStore();
    // Subscribed to here, so switching one on repaints the list, but read
    // through the store, which is where a garbled setting is made sense of.
    useSettingValue("cssThemes");
    const enabled = store.enabledThemeNames;
    const [error, setError] = useState<string>();
    const fileInput = useRef<HTMLInputElement>(null);

    const onImport = useCallback(
        async (event: ChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files ?? []);
            // Picking the same file twice fires no change event unless the
            // input is emptied first, and re-importing a file you have just
            // edited is exactly what somebody will try.
            event.target.value = "";
            if (!files.length) return;

            setError(undefined);
            try {
                await store.importFiles(files);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        },
        [store],
    );

    return (
        <SettingsSubsection
            heading={_t("settings|appearance|css_themes|heading")}
            description={
                store.themesDirectory
                    ? _t("settings|appearance|css_themes|folder_help", { directory: store.themesDirectory })
                    : _t("settings|appearance|css_themes|storage_help")
            }
            legacy={false}
            data-testid="cssThemes"
        >
            <div className="mx_ThemePanel_actions">
                {store.canRevealDirectory && (
                    <Button kind="secondary" size="md" Icon={FolderIcon} onClick={() => void store.reveal()}>
                        {_t("settings|appearance|css_themes|open_folder")}
                    </Button>
                )}
                <Button kind="secondary" size="md" onClick={() => fileInput.current?.click()}>
                    {_t("settings|appearance|css_themes|import")}
                </Button>
                <input
                    ref={fileInput}
                    className="mx_ThemePanel_fileInput"
                    type="file"
                    accept=".css,text/css"
                    multiple
                    aria-label={_t("settings|appearance|css_themes|import")}
                    onChange={onImport}
                />
            </div>

            {error && (
                <div className="mx_ThemePanel_error">
                    {_t("settings|appearance|css_themes|import_failed", { message: error })}
                </div>
            )}

            {store.themes.length === 0 ? (
                <div className="mx_ThemePanel_empty">{_t("settings|appearance|css_themes|empty")}</div>
            ) : (
                <Root className="mx_ThemePanel_themes">
                    {store.themes.map((theme) => (
                        <div key={theme.fileName} className="mx_ThemePanel_theme">
                            <InlineField
                                className="mx_ThemePanel_themeField"
                                name={theme.fileName}
                                control={
                                    <ToggleControl
                                        name={theme.fileName}
                                        checked={enabled.includes(theme.fileName)}
                                        onChange={(event) =>
                                            void store.setEnabled(theme.fileName, event.target.checked)
                                        }
                                    />
                                }
                            >
                                <Label>{theme.fileName}</Label>
                            </InlineField>
                            <IconButton
                                destructive
                                size="28px"
                                aria-label={_t("action|delete")}
                                tooltip={_t("action|delete")}
                                onClick={() => void store.remove(theme.fileName)}
                            >
                                <DeleteIcon />
                            </IconButton>
                        </div>
                    ))}
                </Root>
            )}
        </SettingsSubsection>
    );
}

interface ColourFieldProps {
    label: string;
    /** The chosen colour, or null for the built-in one. */
    value: string | null;
    /** What the picker shows while nothing has been chosen. */
    fallback: string;
    onChange: (colour: string | null) => void;
}

/**
 * One colour of the switcher: a swatch to pick with, and a way back to the
 * default.
 *
 * Plain form elements rather than Compound's, whose `Label` belongs to a Radix
 * form field and whose field controls are not colour swatches.
 */
function ColourField({ label, value, fallback, onChange }: ColourFieldProps): JSX.Element {
    return (
        <div className="mx_ThemePanel_colour">
            <label className="mx_ThemePanel_colourLabel">
                {label}
                <input
                    type="color"
                    className="mx_ThemePanel_swatch"
                    value={value ?? fallback}
                    onChange={(event) => onChange(event.target.value)}
                />
            </label>
            <Button
                kind="tertiary"
                size="md"
                disabled={value === null}
                onClick={() => onChange(null)}
                aria-label={_t("settings|appearance|colours|reset_label", { colour: label })}
            >
                {_t("action|reset")}
            </Button>
        </div>
    );
}

/** A stored colour, or null if there is not one to show. */
const asColour = (stored: unknown): string | null => (typeof stored === "string" ? stored : null);

function PaletteColours(): JSX.Element {
    const accent = asColour(useSettingValue("accentColour"));
    const surface = asColour(useSettingValue("surfaceColour"));

    const set = useCallback((setting: "accentColour" | "surfaceColour", colour: string | null) => {
        void SettingsStore.setValue(setting, null, SettingLevel.DEVICE, colour);
    }, []);

    return (
        <SettingsSubsection
            heading={_t("settings|appearance|colours|heading")}
            description={_t("settings|appearance|colours|help")}
            legacy={false}
            data-testid="themeColours"
        >
            <ColourField
                label={_t("settings|appearance|colours|accent")}
                value={accent}
                fallback={DEFAULT_ACCENT}
                onChange={(colour) => set("accentColour", colour)}
            />
            <ColourField
                label={_t("settings|appearance|colours|surface")}
                value={surface}
                fallback={DEFAULT_SURFACE}
                onChange={(colour) => set("surfaceColour", colour)}
            />
        </SettingsSubsection>
    );
}
