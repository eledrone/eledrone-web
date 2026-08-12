/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";
import { TypedEventEmitter } from "matrix-js-sdk/src/matrix";

import SettingsStore from "../settings/SettingsStore";
import { SettingLevel } from "../settings/SettingLevel";
import PlatformPeg from "../PlatformPeg";
import { type CssThemeFile, type CssThemeSource, StoredCssThemeSource } from "./CssThemeSource";
import { generatePaletteCss } from "./palette";

export enum ThemeEvent {
    /** The themes, or which of them are on, have changed. */
    Update = "update",
}

type EventHandlerMap = {
    [ThemeEvent.Update]: () => void;
};

/** Everything the applied result depends on: a change to any of these re-applies it. */
const WATCHED_SETTINGS = ["cssThemes", "accentColour", "surfaceColour"] as const;

/** Marks the style elements this store owns, so it can take them away again. */
const CSS_THEME_ATTRIBUTE = "data-css-theme";
const PALETTE_ATTRIBUTE = "data-css-palette";

/**
 * The fork's own layer of theming, on top of Element's light and dark.
 *
 * There are two mechanisms and one rule between them:
 *
 * - **CSS themes.** Stylesheets the user wrote or downloaded, kept in a folder
 *   on desktop and in local storage in a browser. Applied verbatim as
 *   unlayered `<style>` elements at the end of `<head>`, which is the highest
 *   priority anything in this app has: unlayered rules beat every `@layer`,
 *   and being last settles ties. A theme can therefore redefine any design
 *   token or restyle any component, the way a Vencord theme does.
 *
 * - **The colour switcher.** Two colours - accent and background tint - turned
 *   into a recolouring of Compound's ramps by {@link generatePaletteCss}. It
 *   lands in the `compound-tokens` layer, underneath everything else.
 *
 * The rule: **a CSS theme wins, token by token.** Both are always written out,
 * and the cascade settles it - a theme is unlayered and the switcher is not,
 * so anything a theme sets beats the switcher's version of it while everything
 * the theme is silent about keeps the picked colours. A theme that only
 * restyles the composer therefore leaves the rest of the app the colour the
 * user chose, rather than dragging it back to Compound's green.
 *
 * Both are written into the widget iframes as well as the app's own document.
 * The call view is Element Call in an iframe, and styles do not cross that
 * boundary - so without this the one screen the accent colour matters most on
 * is the one screen that keeps Compound's green. It works because Element Call
 * puts the same `cpd-theme-dark` class on its own `<body>` and is built from
 * the same design tokens, so the same stylesheet means the same thing there.
 * Only token overrides carry across: `.mx_*` selectors are this app's markup
 * and match nothing inside a widget.
 */
export class ThemeStore extends TypedEventEmitter<ThemeEvent, EventHandlerMap> {
    public static readonly instance = new ThemeStore();

    private source?: CssThemeSource;
    private unwatchSource?: () => void;
    private settingWatchers: string[] = [];
    private available: CssThemeFile[] = [];
    private directory: string | null = null;
    private frameObserver?: MutationObserver;
    /** Frames already being kept up to date, so each is only hooked once. */
    private trackedFrames = new WeakSet<HTMLIFrameElement>();

    /** Every theme the user has, whether or not it is switched on. */
    public get themes(): CssThemeFile[] {
        return this.available;
    }

    /** Where those themes live, when that is somewhere worth naming. */
    public get themesDirectory(): string | null {
        return this.directory;
    }

    /** Whether the user can be shown the folder. False in a browser. */
    public get canRevealDirectory(): boolean {
        return this.source?.canReveal ?? false;
    }

    /**
     * The file names the user has switched on, including any that have since
     * gone missing.
     *
     * Whatever is stored is treated as untrusted: it is device-local JSON that
     * an older version, a hand edit or a half-finished write could leave in
     * any shape, and a theme list is not worth throwing over.
     */
    public get enabledThemeNames(): string[] {
        const stored: unknown = SettingsStore.getValue("cssThemes");
        return Array.isArray(stored) ? stored.filter((name) => typeof name === "string") : [];
    }

    /** One of the two switcher colours, or null if it is unset or unusable. */
    private colourSetting(setting: "accentColour" | "surfaceColour"): string | null {
        const stored: unknown = SettingsStore.getValue(setting);
        return typeof stored === "string" ? stored : null;
    }

    /** Whether any CSS theme is applied. */
    public get isCssThemeApplied(): boolean {
        return this.appliedThemes().length > 0;
    }

    /**
     * Reads the themes and applies them, then keeps doing so as the folder and
     * the settings change.
     */
    public async start(): Promise<void> {
        if (this.source) return;

        // Every platform has a source - the base class answers with browser
        // storage - so the fallback here is only for there being no platform at
        // all, which is early startup and tests rather than a real state.
        this.source = PlatformPeg.get()?.getCssThemeSource() ?? new StoredCssThemeSource();
        this.unwatchSource = this.source.watch(() => void this.refresh());
        this.settingWatchers = WATCHED_SETTINGS.map((setting) =>
            SettingsStore.watchSetting(setting, null, () => this.apply()),
        );
        this.watchFrames();

        await this.refresh();
    }

    public stop(): void {
        this.unwatchSource?.();
        this.unwatchSource = undefined;
        for (const ref of this.settingWatchers) SettingsStore.unwatchSetting(ref);
        this.settingWatchers = [];
        this.frameObserver?.disconnect();
        this.frameObserver = undefined;
        this.trackedFrames = new WeakSet();
        this.source = undefined;
    }

    /** Re-reads the themes from wherever they live, and applies the result. */
    public async refresh(): Promise<void> {
        if (!this.source) return;

        try {
            const { directory, themes } = await this.source.list();
            this.directory = directory;
            this.available = themes;
        } catch (e) {
            // A folder that cannot be read is not a reason to tear down the
            // themes that are already applied - the app keeps whatever it has
            // and says so in the log.
            logger.error("Could not read the CSS themes", e);
            return;
        }

        this.apply();
        this.emit(ThemeEvent.Update);
    }

    /** Whether the named theme is switched on. */
    public isEnabled(fileName: string): boolean {
        return this.enabledThemeNames.includes(fileName);
    }

    /** Switches a theme on or off. */
    public async setEnabled(fileName: string, enabled: boolean): Promise<void> {
        const current = this.enabledThemeNames.filter((name) => name !== fileName);
        const next = enabled ? [...current, fileName] : current;
        await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, next);
        // The watcher fires too, but only once the write has landed; applying
        // here as well is what makes the toggle feel immediate.
        this.apply();
    }

    /**
     * Adds stylesheets, switching each one on as it arrives.
     *
     * Importing is how a browser gets themes at all, and on desktop it saves a
     * trip through the file manager. Either way the file ends up in the same
     * place as one dropped in by hand.
     */
    public async importFiles(files: readonly File[]): Promise<void> {
        if (!this.source) throw new Error("The theme store has not been started");

        for (const file of files) {
            const fileName = normaliseFileName(file.name);
            await this.source.write(fileName, await file.text());
            if (!this.isEnabled(fileName)) {
                await SettingsStore.setValue("cssThemes", null, SettingLevel.DEVICE, [
                    ...this.enabledThemeNames,
                    fileName,
                ]);
            }
        }

        await this.refresh();
    }

    /** Deletes a theme, and forgets that it was on. */
    public async remove(fileName: string): Promise<void> {
        if (!this.source) throw new Error("The theme store has not been started");

        await this.source.remove(fileName);
        await SettingsStore.setValue(
            "cssThemes",
            null,
            SettingLevel.DEVICE,
            this.enabledThemeNames.filter((name) => name !== fileName),
        );
        await this.refresh();
    }

    /** Opens the themes folder in the file manager. Does nothing in a browser. */
    public async reveal(): Promise<void> {
        await this.source?.reveal();
    }

    /**
     * The themes that are on *and* still exist, in the order they were
     * switched on - which is the order they are applied in, so a later theme
     * overrides an earlier one.
     *
     * A name left over from a file that has since been deleted is skipped
     * rather than treated as a theme, which is what lets the colour switcher
     * come back on its own once the last stylesheet is gone.
     */
    private appliedThemes(): CssThemeFile[] {
        const byName = new Map(this.available.map((theme) => [theme.fileName, theme]));
        return this.enabledThemeNames
            .map((name) => byName.get(name))
            .filter((theme): theme is CssThemeFile => theme !== undefined && theme.css.trim().length > 0);
    }

    /** What both mechanisms come out as right now. */
    private resolved(): { themes: CssThemeFile[]; palette: string } {
        return {
            themes: this.appliedThemes(),
            // Written whatever the themes are doing: the cascade decides which
            // of the two owns any given token, so the picked colours stay in
            // effect everywhere a theme has nothing to say.
            palette: generatePaletteCss(this.colourSetting("accentColour"), this.colourSetting("surfaceColour")),
        };
    }

    /** Writes the current themes and colours into the app and its widgets. */
    private apply(): void {
        const { themes, palette } = this.resolved();

        writeInto(document, themes, palette);
        for (const frame of document.querySelectorAll("iframe")) writeIntoFrame(frame, themes, palette);
    }

    /**
     * Keeps widgets in step with the app: they arrive long after the themes do,
     * and a widget that reloads comes back with a document that has never been
     * written into.
     */
    private watchFrames(): void {
        // Reading the added nodes rather than re-querying the document: this
        // runs on every DOM change in the app, and the timeline alone is a lot
        // of them.
        this.frameObserver = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    const element = node as Element;
                    if (element.tagName === "IFRAME") this.trackFrame(element as HTMLIFrameElement);
                    for (const frame of element.querySelectorAll("iframe")) this.trackFrame(frame);
                }
            }
        });
        this.frameObserver.observe(document.documentElement, { childList: true, subtree: true });

        for (const frame of document.querySelectorAll("iframe")) this.trackFrame(frame);
    }

    private trackFrame(frame: HTMLIFrameElement): void {
        if (this.trackedFrames.has(frame)) return;
        this.trackedFrames.add(frame);

        // A widget that reloads or navigates comes back with a fresh document,
        // which has never been written into.
        frame.addEventListener("load", () => this.refreshFrame(frame));

        // A frame that has already loaded gets no load event of its own, and
        // one still loading is written into twice rather than not at all.
        this.refreshFrame(frame);
    }

    private refreshFrame(frame: HTMLIFrameElement): void {
        const { themes, palette } = this.resolved();
        writeIntoFrame(frame, themes, palette);
    }
}

/**
 * Writes into a widget's document, when it is one this app is allowed to touch.
 *
 * The embedded Element Call is served by the app itself, so it is same-origin
 * and its `contentDocument` is right there. A widget from anywhere else - a
 * third-party one, or Element Call pointed elsewhere by
 * `Developer.elementCallUrl` - is not, and the browser hands back null (or
 * throws, depending on which one). Either way it is skipped: there is no
 * reaching into another origin, and a widget that cannot be themed is not an
 * error worth reporting on every apply.
 */
function writeIntoFrame(frame: HTMLIFrameElement, themes: CssThemeFile[], palette: string): void {
    let doc: Document | null = null;
    try {
        doc = frame.contentDocument;
    } catch {
        return;
    }
    if (doc?.head) writeInto(doc, themes, palette);
}

/**
 * Puts the stylesheets at the end of `<head>`, unlayered, and the palette in
 * the `compound-tokens` layer - see {@link generatePaletteCss} for why each of
 * them lands where it does.
 */
function writeInto(doc: Document, themes: CssThemeFile[], palette: string): void {
    for (const style of doc.querySelectorAll(`style[${CSS_THEME_ATTRIBUTE}]`)) style.remove();
    for (const theme of themes) {
        const style = doc.createElement("style");
        style.setAttribute(CSS_THEME_ATTRIBUTE, theme.fileName);
        style.appendChild(doc.createTextNode(theme.css));
        doc.head.appendChild(style);
    }

    let paletteStyle = doc.querySelector<HTMLStyleElement>(`style[${PALETTE_ATTRIBUTE}]`);
    if (!palette) {
        paletteStyle?.remove();
        return;
    }
    if (!paletteStyle) {
        paletteStyle = doc.createElement("style");
        paletteStyle.setAttribute(PALETTE_ATTRIBUTE, "");
        doc.head.appendChild(paletteStyle);
    }
    paletteStyle.textContent = palette;
}

/**
 * A theme is identified by its file name, so the name has to be one a file
 * system will accept and one the desktop side will hand back unchanged.
 * Anything doubtful becomes an underscore rather than being rejected - the
 * user picked this file, and renaming it for them beats refusing it.
 */
function normaliseFileName(name: string): string {
    const trimmed = name.replace(/^.*[\\/]/, "").trim();
    const safe = trimmed.replace(/[^a-z0-9._-]/gi, "_").replace(/^\.+/, "");
    const base = safe.length ? safe : "theme";
    return /\.css$/i.test(base) ? base : `${base}.css`;
}
