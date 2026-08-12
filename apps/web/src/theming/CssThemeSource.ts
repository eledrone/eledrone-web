/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { logger } from "matrix-js-sdk/src/logger";

/** A stylesheet the user has added, named by its file. */
export interface CssThemeFile {
    /** The file's name, e.g. `pink-charcoal.css`. This is the theme's identity. */
    fileName: string;
    /** The stylesheet itself. */
    css: string;
}

/** What a source has to say about itself when asked for its themes. */
export interface CssThemeListing {
    /**
     * The folder the themes came out of, for telling the user where to put
     * more. Null where there is no such place - in a browser there is nowhere
     * to point at.
     */
    directory: string | null;
    themes: CssThemeFile[];
}

/**
 * Where CSS themes are kept.
 *
 * Desktop has a real folder that the user can open and edit in place, and that
 * is the point of the feature: the app is watching, so saving the file is the
 * whole edit loop. A browser has no folder, so the same UI reads and writes
 * local storage instead and the user imports files by hand. Everything above
 * this interface is the same either way.
 */
export interface CssThemeSource {
    /** Whether {@link reveal} does anything - i.e. whether there is a folder to show. */
    readonly canReveal: boolean;

    /** Every theme this source holds. */
    list(): Promise<CssThemeListing>;

    /** Adds a stylesheet, replacing any of the same name. */
    write(fileName: string, css: string): Promise<void>;

    /** Removes a stylesheet. A name that is not there is not an error. */
    remove(fileName: string): Promise<void>;

    /** Shows the user where the themes live, if that is a thing that can be done. */
    reveal(): Promise<void>;

    /**
     * Calls back when the themes change without us doing it - a file saved in
     * the folder, or another tab importing one.
     *
     * @returns a function that stops watching.
     */
    watch(onChange: () => void): () => void;
}

/** Where the browser fallback keeps its themes. Its own key, not part of the settings blob. */
const STORAGE_KEY = "mx_eledrone_css_themes";

/**
 * A ceiling on the lot, well inside the ~5MB an origin gets. Local storage
 * fails by throwing when it is full, and a theme is not worth being the reason
 * something else could not be saved.
 */
const MAX_STORED_BYTES = 2 * 1024 * 1024;

/**
 * The browser's stand-in for a themes folder: local storage, one entry per
 * file name, imported through a file picker.
 *
 * Device-local on purpose. Themes are not synced to the account: a stylesheet
 * is code that runs against the app's markup, and pushing one to every device
 * from a browser tab is a bigger promise than this feature is making.
 */
export class StoredCssThemeSource implements CssThemeSource {
    public readonly canReveal = false;

    private read(): Record<string, string> {
        try {
            const raw = window.localStorage.getItem(STORAGE_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            // Anything but an object of strings is something else's data or a
            // half-written value; starting over beats throwing on every read.
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            return Object.fromEntries(Object.entries(parsed).filter(([, css]) => typeof css === "string")) as Record<
                string,
                string
            >;
        } catch (e) {
            logger.error("Could not read stored CSS themes", e);
            return {};
        }
    }

    private save(themes: Record<string, string>): void {
        const serialised = JSON.stringify(themes);
        if (serialised.length > MAX_STORED_BYTES) {
            throw new Error(
                `Themes take up more than the ${Math.floor(MAX_STORED_BYTES / 1024)}KB this browser allows`,
            );
        }
        window.localStorage.setItem(STORAGE_KEY, serialised);
    }

    public async list(): Promise<CssThemeListing> {
        const stored = this.read();
        return {
            directory: null,
            themes: Object.keys(stored)
                .sort((a, b) => a.localeCompare(b))
                .map((fileName) => ({ fileName, css: stored[fileName] })),
        };
    }

    public async write(fileName: string, css: string): Promise<void> {
        this.save({ ...this.read(), [fileName]: css });
    }

    public async remove(fileName: string): Promise<void> {
        const themes = this.read();
        delete themes[fileName];
        this.save(themes);
    }

    public async reveal(): Promise<void> {}

    public watch(onChange: () => void): () => void {
        // `storage` fires in the app's *other* tabs, not this one, which is
        // exactly what is wanted: our own writes are already applied directly.
        const listener = (event: StorageEvent): void => {
            if (event.key === STORAGE_KEY || event.key === null) onChange();
        };
        window.addEventListener("storage", listener);
        return () => window.removeEventListener("storage", listener);
    }
}
