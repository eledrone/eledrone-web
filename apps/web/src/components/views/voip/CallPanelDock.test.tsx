/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { render } from "test-utils-rtl";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MatrixClient } from "matrix-js-sdk/src/matrix";
import { stubClient } from "../../../../test/test-utils";
import { CallPanelDock } from "./CallPanelDock";
import MatrixClientContext from "../../../contexts/MatrixClientContext";
import { SDKContext } from "../../../contexts/SDKContext";
import { SDKContextClass } from "../../../contexts/SDKContextClass";
import { OwnProfileStore } from "../../../stores/OwnProfileStore";

let client: MatrixClient;

/**
 * The dock inside the layout it is positioned against, since it finds that by
 * looking upwards for `.mx_MatrixChat` rather than being handed it.
 */
const renderInLayout = (): ReturnType<typeof render> =>
    render(
        <div className="mx_MatrixChat">
            <div>
                <nav className="mx_SpacePanel" />
                <div id="left-panel" />
            </div>
            <CallPanelDock />
        </div>,
        {
            wrapper: ({ children }) => (
                <SDKContext.Provider value={SDKContextClass.instance}>
                    <MatrixClientContext.Provider value={client}>{children}</MatrixClientContext.Provider>
                </SDKContext.Provider>
            ),
        },
    );

describe("<CallPanelDock />", () => {
    beforeEach(() => {
        client = stubClient();
        client.getAuthMetadata = vi.fn().mockResolvedValue(undefined);
        OwnProfileStore.instance.setMaxListeners(100);
    });

    it("measures itself onto the layout it sits over", () => {
        const { container } = renderInLayout();
        const root = container.querySelector<HTMLElement>(".mx_MatrixChat")!;

        // happy-dom reports every box as zero, so the values cannot be asserted
        // on - but that they were written at all is the thing that broke: the
        // dock used to take the root as a ref from its own parent, which React
        // has not attached yet when a child's layout effect runs, so the effect
        // gave up and left the dock with no width and no height at all.
        expect(root.style.getPropertyValue("--eledrone-call-dock-width")).not.toBe("");
        expect(root.style.getPropertyValue("--eledrone-call-dock-height")).not.toBe("");
    });

    it("cleans up the reservation when it goes away", () => {
        const { container, unmount } = renderInLayout();
        const root = container.querySelector<HTMLElement>(".mx_MatrixChat")!;

        unmount();

        // Left behind, the two columns would keep reserving space for a panel
        // that is no longer there.
        expect(root.style.getPropertyValue("--eledrone-call-dock-height")).toBe("");
    });

    it("renders the panel inside itself", () => {
        const { container } = renderInLayout();

        expect(container.querySelector(".mx_CallPanelDock .mx_CallPanel")).toBeInTheDocument();
    });
});
