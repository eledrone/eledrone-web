/*
 * Copyright 2025 New Vector Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 *
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, esmExternalRequirePlugin, type Plugin } from "vite";
import dts from "unplugin-dts/vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a CSS module class name that does not depend on the machine doing the build.
 *
 * The default scoped name is derived from the absolute file path, so Windows and Linux
 * produce different class names for identical source. Those names are baked into the
 * published bundle and therefore appear in consumers' test snapshots, which then only
 * match on the platform that built the package.
 *
 * Hashing the repository-relative path with forward slashes makes the output identical
 * everywhere. The file contents are deliberately not hashed: including them would change
 * every class name in a file whenever any rule in it is edited.
 */
function generateScopedName(name: string, filename: string): string {
    const relative = path.relative(packageRoot, filename).split(path.sep).join("/");
    const hash = createHash("sha256").update(relative).digest("hex").slice(0, 8);
    return `_${name}_${hash}`;
}

const cssLayerOrder = "@layer compound-tokens, compound-web, shared-components, app-web;";
const sharedComponentsLayer = "shared-components";

const cssAssetFileName = "element-web-shared-components.css";

function layerCssAssets(): Plugin {
    return {
        name: "element-web-shared-components-css-layer",
        // Rename + layer-wrap the emitted CSS file. With multi-entry lib mode,
        // vite/rolldown derives CSS filenames from the unscoped package name (dropping
        // the `element-` prefix), so we rename on disk to keep the path stable for
        // consumers importing `@element-hq/web-shared-components/.../*.css`.
        writeBundle(options): void {
            const outDir = options.dir ?? fileURLToPath(import.meta.resolve("./dist"));
            const expectedPath = path.resolve(outDir, cssAssetFileName);
            const renamedFromPath = path.resolve(outDir, "web-shared-components.css");

            if (existsSync(renamedFromPath)) {
                renameSync(renamedFromPath, expectedPath);
            }

            // No CSS emitted in this build (e.g. storybook's vite build doesn't produce
            // the library CSS bundle), or already renamed and layered on a prior pass.
            if (!existsSync(expectedPath)) return;

            const source = readFileSync(expectedPath, "utf-8");
            if (source.startsWith(cssLayerOrder)) return;
            writeFileSync(expectedPath, `${cssLayerOrder}\n@layer ${sharedComponentsLayer} {\n${source}\n}\n`);
        },
    };
}

export default defineConfig({
    css: {
        modules: {
            generateScopedName,
        },
    },
    build: {
        lib: {
            // Two entries: the main bundle and a standalone `numbers` utility that callers
            // running outside the browser DOM (e.g. AudioWorkletGlobalScope) can import without
            // pulling in the rest of the package — which transitively loads dnd-kit and
            // other window/document-dependent code.
            entry: {
                "element-web-shared-components": fileURLToPath(import.meta.resolve("./src/index.ts")),
                "numbers": fileURLToPath(import.meta.resolve("./src/core/utils/numbers.ts")),
            },
            name: "Element Web Shared Components",
            // Multi-entry mode needs both formats explicit; UMD doesn't support multi-entry
            // (single global), so we ship ES + CJS and use the `.umd.cjs` extension for CJS
            // to keep the existing package.json `require` paths working.
            formats: ["es", "cjs"],
            fileName: (format, entryName) => `${entryName}.${format === "es" ? "js" : "umd.cjs"}`,
        },
        outDir: "dist",
        rolldownOptions: {
            // make sure to externalize deps that shouldn't be bundled
            // into your library
            external: [
                "@matrix-org/emojibase-bindings",
                "@vector-im/compound-design-tokens",
                "@vector-im/compound-web",
                "react-virtuoso",
                "react-resizable-panels",
            ],
            plugins: [
                esmExternalRequirePlugin({
                    external: ["react", "react-dom"],
                }),
            ],
            output: {
                // Provide global variables to use in the UMD build
                // for externalized deps
                globals: {
                    "react": "react",
                    "@matrix-org/emojibase-bindings": "matrixEmojibaseBindings",
                    "@vector-im/compound-design-tokens": "compoundDesignTokens",
                    "@vector-im/compound-web": "compoundWeb",
                    "react-virtuoso": "reactVirtuoso",
                    "react-resizable-panels": "reactResizablePanels",
                },
            },
        },
    },
    plugins: [
        react(),
        layerCssAssets(),
        dts({
            bundleTypes: {
                invokeOptions: {
                    localBuild: !!process.env.CI,
                    // oxlint-disable-next-line unicorn/prefer-module
                    typescriptCompilerFolder: path.resolve(require.resolve("@typescript/old"), "../.."),
                },
            },
            include: ["src/**/*.{ts,tsx}"],
            exclude: ["src/**/*.test.{ts,tsx}", "src/**/*.stories.{ts,tsx}"],
            copyDtsFiles: false,
        }),
    ],
});
