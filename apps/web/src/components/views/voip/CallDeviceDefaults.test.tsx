/*
Copyright 2026 New Vector Ltd.

SPDX-License-Identifier: AGPL-3.0-only OR GPL-3.0-only OR LicenseRef-Element-Commercial
Please see LICENSE files in the repository root for full details.
*/

// @vitest-environment happy-dom

import React from "react";
import { render, screen, waitFor } from "test-utils-rtl";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import { CallDeviceDefaults } from "./CallDeviceDefaults";
import SettingsStore from "../../../settings/SettingsStore";
import { SettingLevel } from "../../../settings/SettingLevel";
import { isCallDeviceEnabledByDefault } from "../../../utils/call-device-defaults";

describe("<CallDeviceDefaults />", () => {
    beforeEach(async () => {
        await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, false);
        await SettingsStore.setValue("videoInputMuted", null, SettingLevel.DEVICE, false);
    });

    it("offers to turn each device off while they are both on", () => {
        render(<CallDeviceDefaults />);

        expect(screen.getByLabelText("Mute your microphone when joining calls")).toBeInTheDocument();
        expect(screen.getByLabelText("Turn off your camera when joining calls")).toBeInTheDocument();
    });

    it("mutes the microphone for future calls when clicked", async () => {
        render(<CallDeviceDefaults />);

        await userEvent.click(screen.getByLabelText("Mute your microphone when joining calls"));

        await waitFor(() => expect(isCallDeviceEnabledByDefault("audio")).toBe(false));
        // The camera is a separate choice and must be left alone
        expect(isCallDeviceEnabledByDefault("video")).toBe(true);
        expect(await screen.findByLabelText("Unmute your microphone when joining calls")).toBeInTheDocument();
    });

    it("turns the camera off for future calls when clicked", async () => {
        render(<CallDeviceDefaults />);

        await userEvent.click(screen.getByLabelText("Turn off your camera when joining calls"));

        await waitFor(() => expect(isCallDeviceEnabledByDefault("video")).toBe(false));
        expect(isCallDeviceEnabledByDefault("audio")).toBe(true);
        expect(await screen.findByLabelText("Turn on your camera when joining calls")).toBeInTheDocument();
    });

    it("shows the choice already stored for this device", async () => {
        await SettingsStore.setValue("audioInputMuted", null, SettingLevel.DEVICE, true);

        render(<CallDeviceDefaults />);

        expect(screen.getByLabelText("Unmute your microphone when joining calls")).toBeInTheDocument();
    });
});
