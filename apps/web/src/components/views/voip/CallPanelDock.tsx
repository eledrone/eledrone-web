/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

import React, { type JSX, useLayoutEffect, useRef } from "react";
import { LEFT_PANEL_ID } from "@element-hq/web-shared-components";

import { CallPanel } from "./CallPanel";

/**
 * Puts the call panel along the foot of the space rail and the room list, both.
 *
 * It cannot simply be a child of either. The resizable layout is a
 * react-resizable-panels group, which finds its panels by looking through its
 * own direct children - so wrapping the rail and the room list in a column to
 * put something underneath them both would leave the group with one panel and
 * silently break dragging the separator. Instead the dock sits outside the group
 * altogether and is positioned over the corner it covers, with the two columns
 * reserving its height so nothing ends up hidden behind it.
 *
 * That leaves its width to be measured rather than inherited, which is what the
 * observer below is for.
 */
export const CallPanelDock = (): JSX.Element => {
    const dockRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const dock = dockRef.current;
        if (dock === null) return;

        // Found from here rather than handed down as a ref. React attaches refs
        // bottom-up, so a ref set on our own parent is still null while this
        // effect runs - which left the dock zero-width and invisible.
        const root = dock.closest<HTMLElement>(".mx_MatrixChat");
        if (root === null) return;

        const leftPanel = document.getElementById(LEFT_PANEL_ID);
        const rail = root.querySelector<HTMLElement>(".mx_SpacePanel");

        let lastWidth = -1;
        let lastHeight = -1;
        const update = (): void => {
            // The room list's right edge is also the right edge of the two
            // columns together, so one measurement covers both.
            const edge = leftPanel ?? rail;
            const width =
                edge === null ? 0 : Math.round(edge.getBoundingClientRect().right - root.getBoundingClientRect().left);
            const height = dock.offsetHeight;

            // Only on a change: the dock is observed and its width comes from a
            // property we set, so writing unconditionally is a feedback loop.
            if (width !== lastWidth) {
                lastWidth = width;
                root.style.setProperty("--eledrone-call-dock-width", `${Math.max(0, width)}px`);
            }
            if (height !== lastHeight) {
                lastHeight = height;
                root.style.setProperty("--eledrone-call-dock-height", `${height}px`);
            }
        };

        const observer = new ResizeObserver(update);
        // Dragging the separator resizes the room list...
        if (leftPanel !== null) observer.observe(leftPanel);
        // ...but expanding the rail moves the room list without resizing it,
        // because the group preserves pixel sizes, so the rail needs watching too.
        if (rail !== null) observer.observe(rail);
        // And the dock itself grows when a call starts.
        observer.observe(dock);
        update();

        return () => {
            observer.disconnect();
            root.style.removeProperty("--eledrone-call-dock-width");
            root.style.removeProperty("--eledrone-call-dock-height");
        };
    }, []);

    return (
        <div className="mx_CallPanelDock" ref={dockRef}>
            <CallPanel />
        </div>
    );
};
