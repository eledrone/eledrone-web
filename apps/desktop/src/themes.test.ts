/*
Copyright 2026 Element Creations Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, shell } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    deleteTheme,
    ensureThemesDirectory,
    getThemesDirectory,
    listThemes,
    openThemesDirectory,
    resolveThemePath,
    watchThemes,
    writeTheme,
} from "./themes.js";

vi.mock("electron", () => ({
    app: { getPath: vi.fn() },
    shell: { openPath: vi.fn(() => Promise.resolve("")) },
}));

let userData: string;

/** The themes directory the mocked app is pointed at for this test. */
const themesDir = (): string => path.join(userData, "themes");

beforeEach(async () => {
    userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), "eledrone-themes-"));
    vi.mocked(app.getPath).mockReturnValue(userData);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(userData, { recursive: true, force: true });
});

describe("getThemesDirectory", () => {
    it("is a themes folder inside the user data directory", () => {
        expect(getThemesDirectory()).toBe(themesDir());
    });
});

describe("resolveThemePath", () => {
    it("resolves a plain stylesheet name into the themes directory", () => {
        expect(resolveThemePath("pink-charcoal.css")).toBe(path.join(themesDir(), "pink-charcoal.css"));
    });

    it("refuses names that would write somewhere else", () => {
        // These arrive from the renderer, so they are not assumed to be sane
        for (const name of [
            "",
            "..",
            ".hidden.css",
            "sub/theme.css",
            "sub\\theme.css",
            "../../etc/passwd.css",
            "theme.js",
            "theme",
        ]) {
            expect(() => resolveThemePath(name)).toThrow();
        }
    });
});

describe("listThemes", () => {
    it("creates the directory rather than failing when it is not there yet", async () => {
        expect(await listThemes()).toEqual([]);
        expect(fs.existsSync(themesDir())).toBe(true);
    });

    it("returns the stylesheets in name order, with their contents", async () => {
        await ensureThemesDirectory();
        await fs.promises.writeFile(path.join(themesDir(), "pink.css"), "a {}", "utf8");
        await fs.promises.writeFile(path.join(themesDir(), "blue.css"), "b {}", "utf8");

        expect(await listThemes()).toEqual([
            { fileName: "blue.css", css: "b {}" },
            { fileName: "pink.css", css: "a {}" },
        ]);
    });

    it("ignores everything that is not a stylesheet", async () => {
        await ensureThemesDirectory();
        await fs.promises.writeFile(path.join(themesDir(), "theme.css"), "a {}", "utf8");
        await fs.promises.writeFile(path.join(themesDir(), "notes.txt"), "not a theme", "utf8");
        await fs.promises.writeFile(path.join(themesDir(), ".hidden.css"), "editor litter", "utf8");
        await fs.promises.mkdir(path.join(themesDir(), "nested.css"));

        expect(await listThemes()).toEqual([{ fileName: "theme.css", css: "a {}" }]);
    });

    it("takes the extension however it is capitalised", async () => {
        await ensureThemesDirectory();
        await fs.promises.writeFile(path.join(themesDir(), "Theme.CSS"), "a {}", "utf8");

        expect(await listThemes()).toEqual([{ fileName: "Theme.CSS", css: "a {}" }]);
    });

    it("skips a file too large to be a stylesheet somebody wrote", async () => {
        await ensureThemesDirectory();
        await fs.promises.writeFile(path.join(themesDir(), "huge.css"), "x".repeat(5 * 1024 * 1024 + 1), "utf8");
        await fs.promises.writeFile(path.join(themesDir(), "small.css"), "a {}", "utf8");

        expect(await listThemes()).toEqual([{ fileName: "small.css", css: "a {}" }]);
    });
});

describe("writeTheme and deleteTheme", () => {
    it("writes a stylesheet, replacing one of the same name", async () => {
        await writeTheme("theme.css", "a {}");
        await writeTheme("theme.css", "b {}");

        expect(await listThemes()).toEqual([{ fileName: "theme.css", css: "b {}" }]);
    });

    it("deletes a stylesheet, and does not mind one that is already gone", async () => {
        await writeTheme("theme.css", "a {}");

        await deleteTheme("theme.css");
        await deleteTheme("theme.css");

        expect(await listThemes()).toEqual([]);
    });
});

describe("openThemesDirectory", () => {
    it("shows the folder, creating it first so there is something to show", async () => {
        await openThemesDirectory();

        expect(fs.existsSync(themesDir())).toBe(true);
        expect(shell.openPath).toHaveBeenCalledWith(themesDir());
    });
});

describe("watchThemes", () => {
    it("collapses the several events one save produces into one reload", async () => {
        // The OS's own events are not what is under test here - one save
        // producing three of them is a fact about editors, and the debounce is
        // what this owns - so the watcher itself is stood in for.
        let fire: () => void = () => {};
        const close = vi.fn();
        vi.spyOn(fs, "watch").mockImplementation(((_path: string, _options: unknown, listener: () => void) => {
            fire = listener;
            return { close, on: vi.fn() } as unknown as fs.FSWatcher;
        }) as unknown as typeof fs.watch);

        const onChange = vi.fn();
        const stop = watchThemes(onChange);
        // Watching starts once the directory is there, which is a round trip
        await vi.waitFor(() => expect(fs.watch).toHaveBeenCalled());

        vi.useFakeTimers();
        try {
            fire();
            fire();
            fire();
            expect(onChange).not.toHaveBeenCalled();

            vi.advanceTimersByTime(200);
            expect(onChange).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }

        stop();
        expect(close).toHaveBeenCalled();
    });

    it("creates the directory it is asked to watch", async () => {
        const stop = watchThemes(vi.fn());
        await vi.waitFor(() => expect(fs.existsSync(themesDir())).toBe(true));
        stop();
    });
});
