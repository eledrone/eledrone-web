/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import { rejectToast } from "@element-hq/element-web-playwright-common";

import { test, expect } from "../../../element-web-test";
import type { Locator, Page } from "playwright-core";

test.describe("Collapsible Room list", () => {
    test.use({
        displayName: "Alice",
        lockLeftPanelWidth: false,
    });

    test.beforeEach(async ({ page, app, user }) => {
        await rejectToast(page, "Verify this device");
        await rejectToast(page, "Notifications");
        for (let i = 0; i < 10; i++) {
            await app.client.createRoom({ name: `room${i}` });
        }
    });

    /**
     * Resize the panel and return the bounding box
     * @param pixels The number of pixels by which to resize the panel
     */
    async function resize(page: Page, pixels: number): ReturnType<Locator["boundingBox"]> {
        const leftPanelLocator = page.getByTestId("left-panel");
        const boundingBox = await leftPanelLocator.boundingBox();

        // Move mouse 2px to the right of the left-panel, this should be region that the user drags to resize the panel.
        const mouseX = boundingBox!.x + boundingBox!.width + 2;
        const mouseY = boundingBox!.y + boundingBox!.height / 2;

        await page.mouse.move(mouseX, mouseY);
        await page.mouse.down();
        await page.mouse.move(mouseX + pixels, mouseY);

        return boundingBox;
    }

    test("should be possible to expand/contract the room list", { tag: "@screenshot" }, async ({ page, app, user }) => {
        await expect(page).toMatchScreenshot("room-list-collapse-default.png");
        const leftPanelLocator = page.getByTestId("left-panel");

        // Contract the panel
        let previousBoundingBox = await resize(page, -50);
        let currentBoundingBox = await leftPanelLocator.boundingBox();
        expect(currentBoundingBox!.width).toBeCloseTo(previousBoundingBox!.width - 50, 0);

        // Expand the panel
        previousBoundingBox = await resize(page, 30);
        currentBoundingBox = await leftPanelLocator.boundingBox();
        expect(currentBoundingBox!.width).toBeCloseTo(previousBoundingBox!.width + 30, 0);
    });

    test(
        "should stop at its minimum width rather than collapsing",
        { tag: "@screenshot" },
        async ({ page, app, user }) => {
            const leftPanelLocator = page.getByTestId("left-panel");

            // Drag far past where the panel used to snap shut. The call panel
            // runs along the foot of this column and has to stay readable, so
            // the panel holds its minimum instead of collapsing to nothing.
            await resize(page, -300);
            const currentBoundingBox = await leftPanelLocator.boundingBox();
            expect(currentBoundingBox!.width).toBeGreaterThanOrEqual(200);

            // Every control is still there, and still says what it does
            await expect(page.getByRole("button", { name: "Mute microphone" })).toBeVisible();
            await expect(page.getByRole("button", { name: "Quick settings" })).toBeVisible();
            await expect(page.getByRole("button", { name: "User menu" })).toBeVisible();

            await expect(page).toMatchScreenshot("room-list-collapse-minimum-width.png");
        },
    );
});
