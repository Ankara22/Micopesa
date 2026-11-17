import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import NotificationAuditPage from "./NotificationAuditPage";

const mocks = vi.hoisted(() => ({
    listNotificationAudit: vi.fn(),
}));

vi.mock("../../services/notificationService", () => ({
    listNotificationAudit: mocks.listNotificationAudit,
}));

const emptyResponse = {
    records: [],
    pagination: { page: 1, total_pages: 0 },
    summary: { total_count: 0, authorized_count: 0, denied_count: 0 },
};

describe("Notification audit page", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mocks.listNotificationAudit.mockResolvedValue(emptyResponse);
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("renders scoped audit details and applies all supported filters", async () => {
        mocks.listNotificationAudit.mockResolvedValue({
            records: [{
                audit_event_id: "audit-1",
                created_at: "2026-03-01T10:00:00Z",
                sender_name: "Fund Officer",
                sender_role: "FUND_MANAGER",
                recipient_name: "Member",
                recipient_phone_masked: "+254 7** *** 123",
                recipient_email_masked: "m***@example.test",
                recipient_phone: "+254700000000",
                recipient_email: "private@example.test",
                notification_category: "FUND_UPDATE",
                channels: ["SMS"],
                authorization_outcome: "AUTHORIZED",
                delivery_results: [{ channel: "SMS", delivery_status: "DELIVERED" }],
            }],
            pagination: { page: 1, total_pages: 2 },
            summary: { total_count: 1, authorized_count: 1, denied_count: 0 },
        });
        render(<NotificationAuditPage />);

        const table = await screen.findByRole("table");
        expect(table).toHaveTextContent("Fund Officer");
        expect(table).toHaveTextContent("+254 7** *** 123");
        expect(table).toHaveTextContent("m***@example.test");
        expect(table).not.toHaveTextContent("+254700000000");
        expect(table).not.toHaveTextContent("private@example.test");

        fireEvent.change(screen.getByLabelText("From date"), { target: { value: "2026-03-01" } });
        fireEvent.change(screen.getByLabelText("To date"), { target: { value: "2026-03-31" } });
        fireEvent.change(screen.getByLabelText("Channel"), { target: { value: "SMS" } });
        fireEvent.change(screen.getByLabelText("Authorization result"), { target: { value: "DENIED" } });
        fireEvent.change(screen.getByLabelText("Delivery status"), { target: { value: "FAILED" } });
        fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));

        await waitFor(() => {
            expect(mocks.listNotificationAudit).toHaveBeenLastCalledWith({
                start_date: "2026-03-01",
                end_date: "2026-03-31",
                channel: "SMS",
                authorization_outcome: "DENIED",
                delivery_status: "FAILED",
                page: 1,
                page_size: 25,
            });
        });
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => {
            expect(mocks.listNotificationAudit).toHaveBeenLastCalledWith({
                start_date: "2026-03-01",
                end_date: "2026-03-31",
                channel: "SMS",
                authorization_outcome: "DENIED",
                delivery_status: "FAILED",
                page: 2,
                page_size: 25,
            });
        });
    });

    it("shows a true empty state and retries a failed audit request", async () => {
        mocks.listNotificationAudit
            .mockRejectedValueOnce(new Error("Audit history is unavailable."))
            .mockResolvedValueOnce(emptyResponse);
        render(<NotificationAuditPage />);

        expect(await screen.findByRole("alert")).toHaveTextContent("Audit history is unavailable.");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("No notification activity is available in your authorized scope."))
            .toBeInTheDocument();
        expect(screen.getAllByText("0")).toHaveLength(3);
        expect(mocks.listNotificationAudit).toHaveBeenCalledTimes(2);
    });

    it("does not turn a malformed audit response into an empty result", async () => {
        mocks.listNotificationAudit.mockResolvedValue({
            records: undefined,
            pagination: { page: 1, total_pages: 0 },
            summary: { total_count: 0, authorized_count: 0, denied_count: 0 },
        });
        render(<NotificationAuditPage />);

        expect(await screen.findByRole("alert"))
            .toHaveTextContent("The service returned information in an unexpected format.");
        expect(screen.queryByText("No notification activity is available in your authorized scope."))
            .not.toBeInTheDocument();
    });
});
