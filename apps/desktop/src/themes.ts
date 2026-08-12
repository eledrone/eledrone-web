/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { app, shell } from "electron";
import fs from "node:fs";
import path from "node:path";

/** A stylesheet found in the themes directory. */
export interface DesktopTheme {
    /** The file's name, e.g. `pink-charcoal.css`. Identifies the theme everywhere. */
    fileName: string;
    /** The stylesheet itself. */
    css: string;
}

/** The directory's name inside the user data directory. */
export const THEMES_DIRECTORY_NAME = "themes";

/**
 * A ceiling on what will be read and handed to the renderer. A stylesheet is
 * text a person wrote; anything past this is a file that landed in the folder
 * by mistake, and reading it would only block the main process and bloat the
 * IPC message.
 */
const MAX_THEME_BYTES = 5 * 1024 * 1024;

/**
 * Editors do not save a file once. They write, rename and touch, and each of
 * those is an event; a save can easily produce three. This is long enough to
 * collapse one save into one reload and short enough to feel immediate.
 */
const WATCH_DEBOUNCE_MS = 150;

/** Where the user's theme stylesheets live. */
export function getThemesDirectory(): string {
    return path.join(app.getPath("userData"), THEMES_DIRECTORY_NAME);
}

/**
 * Resolves a theme's file name to a path inside the themes directory.
 *
 * The name arrives from the renderer, so it is treated as untrusted input: it
 * must be a plain `.css` file name and nothing else. Anything containing a
 * separator, a parent reference or another extension is refused rather than
 * sanitised, so a bug in the caller cannot quietly write somewhere else.
 */
export function resolveThemePath(fileName: string): string {
    // Separators are checked directly rather than via path.basename, which
    // answers differently per platform: to POSIX a backslash is an ordinary
    // character, so "sub\theme.css" reads as one legal file name on Linux and as
    // a subdirectory on Windows. Deciding that here rather than letting the host
    // decide means a name is either acceptable everywhere or refused everywhere,
    // and a themes directory carried between machines cannot change meaning.
    const isPlainCssFileName =
        fileName.length > 0 &&
        !/[\\/]/.test(fileName) &&
        !fileName.startsWith(".") &&
        path.extname(fileName).toLowerCase() === ".css";

    if (!isPlainCssFileName) {
        throw new Error(`Refusing to use ${JSON.stringify(fileName)} as a theme file name`);
    }
    return path.join(getThemesDirectory(), fileName);
}

/** Creates the themes directory if it is not there yet. Safe to call repeatedly. */
export async function ensureThemesDirectory(): Promise<string> {
    const directory = getThemesDirectory();
    await fs.promises.mkdir(directory, { recursive: true });
    return directory;
}

/**
 * Every stylesheet in the themes directory, in name order.
 *
 * One unreadable file does not hide the rest: it is logged and skipped, since
 * the alternative is a themes list that empties itself because of a file the
 * user may not even have meant to put there.
 */
export async function listThemes(): Promise<DesktopTheme[]> {
    const directory = await ensureThemesDirectory();
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    const themes: DesktopTheme[] = [];

    for (const entry of entries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".css" || entry.name.startsWith(".")) {
            continue;
        }

        const filePath = path.join(directory, entry.name);
        try {
            const { size } = await fs.promises.stat(filePath);
            if (size > MAX_THEME_BYTES) {
                console.warn(`Skipping theme ${entry.name}: ${size} bytes is larger than the ${MAX_THEME_BYTES} limit`);
                continue;
            }
            themes.push({ fileName: entry.name, css: await fs.promises.readFile(filePath, "utf8") });
        } catch (e) {
            console.error(`Failed to read theme ${entry.name}`, e);
        }
    }

    return themes.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/** Writes a stylesheet into the themes directory, replacing any file of that name. */
export async function writeTheme(fileName: string, css: string): Promise<void> {
    await ensureThemesDirectory();
    await fs.promises.writeFile(resolveThemePath(fileName), css, "utf8");
}

/** Removes a stylesheet from the themes directory. Missing files are not an error. */
export async function deleteTheme(fileName: string): Promise<void> {
    await fs.promises.rm(resolveThemePath(fileName), { force: true });
}

/** Shows the themes directory in the OS file manager, creating it first if need be. */
export async function openThemesDirectory(): Promise<void> {
    await shell.openPath(await ensureThemesDirectory());
}

/**
 * Watches the themes directory, calling back when its contents change.
 *
 * Non-recursive and non-persistent: themes are files directly in the folder,
 * and the watcher must never be the reason the process stays alive.
 *
 * @returns a function that stops watching.
 */
export function watchThemes(onChange: () => void): () => void {
    let watcher: fs.FSWatcher | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let stopped = false;

    void ensureThemesDirectory()
        .then((directory) => {
            if (stopped) return;
            watcher = fs.watch(directory, { persistent: false }, () => {
                if (timeout) clearTimeout(timeout);
                timeout = setTimeout(onChange, WATCH_DEBOUNCE_MS);
            });
            // A watcher on a directory that is later deleted or moved emits an
            // error rather than throwing. Losing live reload is not worth
            // taking the process down for, so it is logged and left alone.
            watcher.on("error", (e) => console.error("Themes directory watcher failed", e));
        })
        .catch((e) => console.error("Could not watch the themes directory", e));

    return () => {
        stopped = true;
        if (timeout) clearTimeout(timeout);
        watcher?.close();
    };
}
