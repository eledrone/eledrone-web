/*
 * Copyright 2026 Element Creations Ltd.
 *
 * SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
 * Please see LICENSE files in the repository root for full details.
 */

import {
    BaseViewModel,
    type LeftResizablePanelViewActions,
    type SeparatorViewActions,
    type PanelSize,
    type PanelImperativeHandle,
    type GroupViewActions,
    type ResizerViewSnapshot,
} from "@element-hq/web-shared-components";
import { debounce } from "lodash";
import { type PointerEvent } from "react";

import SettingsStore from "../../settings/SettingsStore";
import { SettingLevel } from "../../settings/SettingLevel";

/**
 * The panel never starts collapsed, because it never collapses at all: the call
 * panel sits along the foot of it and has to stay legible, so the panel keeps a
 * width that fits it. A collapsed state stored by an older version is ignored
 * rather than migrated - reading it would just hide the panel once, and the
 * user can resize from there.
 */
function getInitialState(): ResizerViewSnapshot {
    return {
        isCollapsed: false,
        initialSize: SettingsStore.getValue("RoomList.panelSize") ?? undefined,
    };
}

/**
 * Viewmodel that drives the resizable left panel.
 */
export class ResizerViewModel
    extends BaseViewModel<ResizerViewSnapshot, void>
    implements SeparatorViewActions, LeftResizablePanelViewActions, GroupViewActions
{
    /**
     * This object gives us access to the API methods of react-resizable-panels library.
     */
    private panelHandle?: PanelImperativeHandle;

    /**
     * Needed to distinguish between a drag and a click on the separator.
     */
    private readonly mouseClickHandler: MouseClickHandler;

    /**
     * Tracks whether we've seen the first resized event.
     */
    private firstResizedEventSeen = false;

    public constructor() {
        super(undefined, getInitialState());

        // Run onSeparatorClick when the separator is clicked.
        this.mouseClickHandler = new MouseClickHandler(this.onSeparatorClick);
    }

    public onLeftPanelResize = debounce((panelSize: PanelSize): void => {
        const newSize = panelSize.inPixels;
        this.snapshot.merge({ isCollapsed: newSize === 0 });
    }, 50);

    public onLeftPanelResized = (newSize: number): void => {
        if (!this.firstResizedEventSeen) {
            // When the panel is first rendered, we get a resized event.
            // This should be ignored to prevent rewriting the setting value and
            // to avoid confusing the collapse behaviour code.
            this.firstResizedEventSeen = true;
            return;
        }

        const isCollapsed = newSize === 0;
        // Store the size if the panel isn't collapsed.
        if (!isCollapsed) {
            SettingsStore.setValue("RoomList.panelSize", null, SettingLevel.DEVICE, newSize);
        }
        // Store whether the panel was collapsed.
        // This is stored separately instead of being inferred from the stored panel size so that
        // the panel can be restored to its last known non-zero width even after app reload, which
        // we wouldn't be able to do if we stored panelSize as zero.
        SettingsStore.setValue("RoomList.isPanelCollapsed", null, SettingLevel.DEVICE, isCollapsed);
    };

    public setPanelHandle = (handle: PanelImperativeHandle): void => {
        this.panelHandle = handle;
    };

    private onSeparatorClick = (): void => {
        // The panel cannot collapse itself any more, but a width stored by an
        // older version can still leave it at zero on the first render, so it
        // stays possible to click one's way out of that.
        if (this.panelHandle?.isCollapsed()) {
            const lastSize = SettingsStore.getValue("RoomList.panelSize");
            this.panelHandle.resize(`${lastSize ?? 100}%`);
        }
    };

    /**
     * Double clicking the separator used to collapse the panel. It no longer
     * does: the call panel lives along the foot of the panel, and hiding it by
     * accident - which a stray double click is - is not something to offer.
     */
    public onDoubleClick = (): void => {};

    public onPointerUp = (): void => {
        this.mouseClickHandler.onPointerUp();
    };

    public onPointerMove = (event: PointerEvent): void => {
        this.mouseClickHandler.onPointerMove(event.clientX, event.clientY);
    };

    public onPointerDown = (event: PointerEvent): void => {
        this.mouseClickHandler.onPointerDown(event.clientX, event.clientY);
    };
}

/**
 * How far the pointer may travel between going down and coming up and still count as a click rather
 * than a drag. A trackpad rarely holds a pointer perfectly still, and a separator that only opens on
 * a pixel-perfect click reads as one that ignores clicks.
 */
const CLICK_TOLERANCE_PX = 5;

/**
 * Dragging the separator will emit a click event.
 * This class uses pointer event handlers to distinguish between a drag and a click
 * on the separator.
 */
class MouseClickHandler {
    public constructor(private readonly onClick: () => void) {}

    /** Where the pointer went down, for as long as it is down. */
    private origin: { x: number; y: number } | null = null;
    private isResize = false;

    public onPointerUp = (): void => {
        this.origin = null;
        if (!this.isResize) this.onClick();
    };

    public onPointerDown = (x: number, y: number): void => {
        this.origin = { x, y };
        this.isResize = false;
    };

    public onPointerMove = (x: number, y: number): void => {
        // Moving across the separator with no button held is not a drag, and must not be allowed to
        // spend the next click.
        if (!this.origin) return;

        if (Math.abs(x - this.origin.x) > CLICK_TOLERANCE_PX || Math.abs(y - this.origin.y) > CLICK_TOLERANCE_PX) {
            this.isResize = true;
        }
    };
}
