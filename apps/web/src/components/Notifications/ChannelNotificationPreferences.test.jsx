import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import {
    getMyNotificationPreferences,
    updateMyNotificationPreferences,
} from "../../services/notificationService";
import ChannelNotificationPreferences from "./ChannelNotificationPreferences";

vi.mock("../../services/notificationService", () => ({
    getMyNotificationPreferences: vi.fn(),
    updateMyNotificationPreferences: vi.fn(),
}));

describe("ChannelNotificationPreferences", () => {
    afterEach(async () => {
        cleanup();
        await i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        getMyNotificationPreferences.mockResolvedValue({
            email_enabled: false,
            sms_enabled: false,
            email_registered: true,
            email_verified: false,
            phone_registered: true,
            phone_verified: true,
            push_enabled: true,
            sms_delivery_enabled: true,
            email_delivery_enabled: false,
            push_delivery_enabled: false,
        });
    });

    it("loads and saves only the current user's email and SMS channel choices", async () => {
        updateMyNotificationPreferences.mockResolvedValue({
            email_enabled: true,
            sms_enabled: false,
            email_registered: true,
            email_verified: false,
            phone_registered: true,
            phone_verified: true,
            push_enabled: true,
            sms_delivery_enabled: true,
            email_delivery_enabled: false,
            push_delivery_enabled: false,
        });
        render(<ChannelNotificationPreferences />);

        const email = await screen.findByLabelText("Email notifications");
        const sms = screen.getByLabelText("SMS notifications");
        expect(email).not.toBeChecked();
        expect(sms).not.toBeChecked();

        fireEvent.click(email);
        fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

        await waitFor(() => {
            expect(updateMyNotificationPreferences).toHaveBeenCalledWith({
                email_enabled: true,
                sms_enabled: false,
            });
        });
        expect(await screen.findByText("Notification preferences saved.")).toBeInTheDocument();
        expect(screen.getByText(/The registered email address is not verified yet/)).toBeInTheDocument();
        expect(screen.getByText("The registered phone number is verified.")).toBeInTheDocument();
        expect(screen.getByText(/A browser push subscription is registered for this account/)).toBeInTheDocument();
        expect(screen.getByText(/Email delivery is currently unavailable/)).toBeInTheDocument();
    });

    it("reloads saved channel choices after the preferences view is remounted", async () => {
        let persisted = {
            email_enabled: false,
            sms_enabled: false,
            email_registered: true,
            email_verified: true,
            phone_registered: true,
            phone_verified: true,
            push_enabled: false,
        };
        getMyNotificationPreferences.mockImplementation(async () => ({ ...persisted }));
        updateMyNotificationPreferences.mockImplementation(async (changes) => {
            persisted = { ...persisted, ...changes };
            return { ...persisted };
        });

        const firstView = render(<ChannelNotificationPreferences />);
        fireEvent.click(await screen.findByLabelText("Email notifications"));
        fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
        await waitFor(() => expect(persisted.email_enabled).toBe(true));
        firstView.unmount();

        render(<ChannelNotificationPreferences />);

        expect(await screen.findByLabelText("Email notifications")).toBeChecked();
        expect(getMyNotificationPreferences).toHaveBeenCalledTimes(2);
    });

    it("shows a retryable generic error if preferences cannot be loaded", async () => {
        getMyNotificationPreferences.mockRejectedValue(new Error("sensitive provider detail"));
        render(<ChannelNotificationPreferences />);

        expect(await screen.findByText(
            "Unable to load notification preferences.",
        )).toBeInTheDocument();
        expect(screen.queryByText("sensitive provider detail")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    });

    it("keeps the existing preference state and shows a generic error if saving fails", async () => {
        updateMyNotificationPreferences.mockRejectedValue(new Error("provider token detail"));
        render(<ChannelNotificationPreferences />);

        const email = await screen.findByLabelText("Email notifications");
        fireEvent.click(email);
        fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));

        expect(await screen.findByText(
            "Unable to save notification preferences.",
        )).toBeInTheDocument();
        expect(screen.queryByText("provider token detail")).not.toBeInTheDocument();
        expect(email).toBeChecked();
    });
});
