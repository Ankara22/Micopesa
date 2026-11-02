import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Notifications from "./Notifications";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({ getMyNotifications: vi.fn() }));

vi.mock("../../services/notificationService", () => ({
    getMyNotifications: mocks.getMyNotifications,
}));

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
        expect(screen.getByText("Barua pepe")).toBeInTheDocument();
        expect(screen.getByText("Imetumwa")).toBeInTheDocument();
        expect(screen.getByText("Your account is ready")).toBeInTheDocument();
    });
});
