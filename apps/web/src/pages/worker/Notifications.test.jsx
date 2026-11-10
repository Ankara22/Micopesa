import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Notifications from "./Notifications";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({ getMyNotifications: vi.fn(), useAuth: vi.fn() }));

vi.mock("../../services/notificationService", () => ({
    getMyNotifications: mocks.getMyNotifications,
    getPushPublicKey: vi.fn(),
    registerPushSubscription: vi.fn(),
    removePushSubscription: vi.fn(),
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("worker notifications loading and retry", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.useAuth.mockReturnValue({ user: { user_id: "worker-1" } });
    });

    it("shows an accessible retry after initial failure and loads notifications on success", async () => {
        const retry = deferred();
        mocks.getMyNotifications
            .mockRejectedValueOnce(new Error("Notifications unavailable"))
            .mockReturnValueOnce(retry.promise);
        render(<Notifications />);

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this information right now");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("status", { name: "Loading records" })).toBeInTheDocument();

        retry.resolve([{
            notification_id: "notice-1",
            created_at: "2026-10-26T10:00:00Z",
            notification_type: "ACCOUNT",
            message: "Your account is ready",
            delivery_status: "SENT",
        }]);
        expect(await screen.findByText("Your account is ready")).toBeInTheDocument();
        expect(screen.queryByText("No notifications are available")).not.toBeInTheDocument();
    });

    it("keeps the retry action available when the retry also fails", async () => {
        mocks.getMyNotifications
            .mockRejectedValueOnce(new Error("First failure"))
            .mockRejectedValueOnce(new Error("Retry failure"));
        render(<Notifications />);

        fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to load this information right now");
        expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
        await waitFor(() => expect(mocks.getMyNotifications).toHaveBeenCalledTimes(2));
    });

    it("shows the empty state only after a successful empty response", async () => {
        mocks.getMyNotifications.mockResolvedValue([]);
        render(<Notifications />);

        expect(await screen.findByText("You have no notifications yet.")).toBeInTheDocument();
    });

    it("translates worker notification labels and status while leaving message content as received", async () => {
        await i18n.changeLanguage("sw");
        mocks.getMyNotifications.mockResolvedValue([{
            notification_id: "notice-2",
            created_at: "2026-10-26T10:00:00Z",
            notification_type: "EMAIL",
            message: "Your account is ready",
            delivery_status: "SENT",
        }]);
        render(<Notifications />);

        expect(await screen.findByRole("heading", { name: "Arifa" })).toBeInTheDocument();
        expect(screen.getByText("Barua pepe", { selector: ".notification-channel" })).toBeInTheDocument();
        expect(screen.getByText("Imekubaliwa na mtoa huduma", { selector: ".badge" })).toBeInTheDocument();
        expect(screen.getByText("Imekubaliwa na mtoa huduma", { selector: ".badge" }).closest(".badge"))
            .toHaveClass("badge-blue");
        expect(screen.queryByText("Imefika", { selector: ".badge" })).not.toBeInTheDocument();
        expect(screen.getByText("Your account is ready")).toBeInTheDocument();
    });

    it("uses distinct badge colors for expanded notification delivery states", async () => {
        mocks.getMyNotifications.mockResolvedValue([
            "PENDING", "PROCESSING", "PROVIDER_ACCEPTED", "DELIVERED", "FAILED", "UNKNOWN",
        ].map((delivery_status, index) => ({
            notification_id: `notice-${index}`,
            created_at: "2026-10-26T10:00:00Z",
            notification_type: "SMS",
            message: `Notification ${index}`,
            delivery_status,
        })));
        render(<Notifications />);

        const statusColors = [
            ["Pending", "badge-yellow"],
            ["In progress", "badge-blue"],
            ["Accepted by provider", "badge-blue"],
            ["Delivered", "badge-green"],
            ["Failed", "badge-red"],
            ["Unknown", "badge-yellow"],
        ];
        for (const [label, color] of statusColors) {
            await waitFor(() => {
                expect(screen.getAllByText(label).some((item) =>
                    item.closest(".badge")?.classList.contains(color)
                )).toBe(true);
            });
        }
    });

    it("filters the notification timeline by channel and status", async () => {
        mocks.getMyNotifications.mockResolvedValue([
            {
                notification_id: "notice-sms",
                created_at: "2026-10-26T10:00:00Z",
                notification_type: "SMS",
                message: "Your contribution was received",
                delivery_status: "DELIVERED",
            },
            {
                notification_id: "notice-email",
                created_at: "2026-10-26T10:00:00Z",
                notification_type: "EMAIL",
                message: "Your account update",
                delivery_status: "PENDING",
            },
        ]);
        render(<Notifications />);

        expect(await screen.findByText("Your contribution was received")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Type"), { target: { value: "EMAIL" } });
        fireEvent.change(screen.getByLabelText("Status"), { target: { value: "PENDING" } });

        expect(screen.getByText("Your account update")).toBeInTheDocument();
        expect(screen.queryByText("Your contribution was received")).not.toBeInTheDocument();
    });
});
