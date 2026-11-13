import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import Notifications from "./Notifications";

const mocks = vi.hoisted(() => ({
    createNotification: vi.fn(),
    getExternalSmsAvailability: vi.fn(),
    listNotificationRecipients: vi.fn(),
    listNotifications: vi.fn(),
    sendExternalRecipientSms: vi.fn(),
    sendAdminTestSms: vi.fn(),
    getMyNotificationPreferences: vi.fn(),
    updateMyNotificationPreferences: vi.fn(),
}));

vi.mock("../../services/adminService", () => ({
    createNotification: mocks.createNotification,
    getExternalSmsAvailability: mocks.getExternalSmsAvailability,
    listNotificationRecipients: mocks.listNotificationRecipients,
    listNotifications: mocks.listNotifications,
    sendExternalRecipientSms: mocks.sendExternalRecipientSms,
    sendAdminTestSms: mocks.sendAdminTestSms,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: () => ({ user: { user_id: "admin-1" } }),
}));
vi.mock("../../services/notificationService", () => ({
    getMyNotificationPreferences: mocks.getMyNotificationPreferences,
    updateMyNotificationPreferences: mocks.updateMyNotificationPreferences,
}));

function renderPage() {
    return render(<ToastProvider><Notifications /></ToastProvider>);
}

describe("admin unified notifications", () => {
    let originalCrypto;

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getMyNotificationPreferences.mockResolvedValue({
            email_enabled: false,
            sms_enabled: false,
        });
        originalCrypto = Object.getOwnPropertyDescriptor(window, "crypto");
        Object.defineProperty(window, "crypto", {
            configurable: true,
            value: { randomUUID: () => "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5" },
        });
        mocks.listNotifications.mockResolvedValue([]);
        mocks.getExternalSmsAvailability.mockResolvedValue({ enabled: false });
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "worker-1",
            full_name: "Akinyi Worker",
            role: "WORKER",
            phone: "0712345678",
            email: "worker@example.test",
            push_subscription_count: 1,
        }, {
            user_id: "worker-2",
            full_name: "Binti Worker",
            role: "WORKER",
            phone: "",
            email: "binti@example.test",
            push_subscription_count: 0,
        }]);
        mocks.createNotification.mockResolvedValue([
            { notification_id: "sms-1", notification_type: "SMS", delivery_status: "PENDING" },
            { notification_id: "email-1", notification_type: "EMAIL", delivery_status: "PENDING" },
            { notification_id: "push-1", notification_type: "PUSH", delivery_status: "PENDING" },
        ]);
        mocks.sendAdminTestSms.mockResolvedValue([{
            notification_id: "test-sms-1",
            notification_type: "SMS",
            delivery_status: "PENDING",
        }]);
        mocks.sendExternalRecipientSms.mockResolvedValue({
            notification_id: "external-sms-1",
            notification_type: "SMS",
            recipient_phone: "+254712345678",
            delivery_status: "PROVIDER_ACCEPTED",
        });
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
        if (originalCrypto) Object.defineProperty(window, "crypto", originalCrypto);
    });

    it("previews and confirms independent SMS, email, and push messages for one worker", async () => {
        mocks.createNotification.mockImplementationOnce(async () => {
            mocks.listNotifications.mockResolvedValue([
                {
                    notification_id: "sms-1",
                    notification_type: "SMS",
                    delivery_status: "PROVIDER_ACCEPTED",
                    admin_request_key: "request-1",
                    user_id: "worker-1",
                    provider_message_id: "sms-provider-1",
                    provider_accepted_at: "2025-01-02T03:04:05.000Z",
                },
                {
                    notification_id: "email-1",
                    notification_type: "EMAIL",
                    delivery_status: "FAILED",
                    last_error_code: "EMAIL_SMTP_AUTH_FAILED",
                    admin_request_key: "request-1",
                    user_id: "worker-1",
                },
                {
                    notification_id: "push-1",
                    notification_type: "PUSH",
                    delivery_status: "UNKNOWN",
                    admin_request_key: "request-1",
                    user_id: "worker-1",
                },
            ]);
            return [
                { notification_id: "sms-1", notification_type: "SMS", delivery_status: "PENDING" },
                { notification_id: "email-1", notification_type: "EMAIL", delivery_status: "PENDING" },
                { notification_id: "push-1", notification_type: "PUSH", delivery_status: "PENDING" },
            ];
        });
        renderPage();

        fireEvent.click(await screen.findByLabelText("Akinyi Worker (Worker)"));
        fireEvent.change(screen.getByLabelText("Search by name, email, phone, or account ID"), {
            target: { value: "worker@example.test" },
        });

        await waitFor(() => {
            expect(mocks.listNotificationRecipients).toHaveBeenLastCalledWith("worker@example.test");
        });
        fireEvent.click(screen.getByLabelText("SMS"));
        fireEvent.click(screen.getByLabelText("Email"));
        fireEvent.click(screen.getByLabelText("Push notification"));
        fireEvent.change(screen.getByLabelText("Email subject"), {
            target: { value: "Savings update" },
        });
        fireEvent.change(screen.getByLabelText("Push notification title"), {
            target: { value: "Account update" },
        });
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Your contribution was recorded." },
        });
        fireEvent.change(screen.getByLabelText("Optional formatted email body (HTML)"), {
            target: { value: '<p>Hello <strong>member</strong><script>alert(1)</script></p>' },
        });

        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        const dialog = await screen.findByRole("dialog", { name: "Review before queueing" });
        expect(dialog).toHaveTextContent("Akinyi Worker");
        expect(dialog).toHaveTextContent("worker@example.test");
        expect(dialog).toHaveTextContent("Your contribution was recorded.");
        expect(dialog).toHaveTextContent("Hello member");
        expect(dialog).not.toHaveTextContent("alert(1)");
        expect(dialog).toHaveTextContent("Preview only: nothing is queued or sent");
        expect(mocks.createNotification).not.toHaveBeenCalled();
        expect(mocks.sendAdminTestSms).not.toHaveBeenCalled();
        expect(mocks.sendExternalRecipientSms).not.toHaveBeenCalled();

        const confirm = screen.getByRole("button", { name: "Confirm and queue" });
        fireEvent.click(confirm);
        fireEvent.click(confirm);

        await waitFor(() => expect(mocks.createNotification).toHaveBeenCalledTimes(1));
        expect(await screen.findByText(/Notification request queued/)).toBeInTheDocument();
        expect(mocks.createNotification).toHaveBeenCalledWith({
            user_ids: ["worker-1"],
            channels: ["SMS", "EMAIL", "PUSH"],
            category: "ANNOUNCEMENT",
            message: "Your contribution was recorded.",
            subject: "Savings update",
            html: '<p>Hello <strong>member</strong><script>alert(1)</script></p>',
            title: "Account update",
            request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        });
        await waitFor(() => {
            const resultCard = screen.getByRole("heading", { name: "Result" }).closest(".admin-card");
            const resultLines = within(resultCard).getAllByRole("listitem")
                .map((item) => item.textContent)
                .filter((text) => /Text message|Email|Push notification/.test(text));
            expect(resultLines).toHaveLength(3);
            expect(resultLines[0]).toContain("Text message");
            expect(resultLines[0]).toContain("Sent");
            expect(resultLines[0]).toContain("Partially sent");
            expect(resultLines[0]).toContain("sms-provider-1");
            expect(resultLines[1]).toContain("Email");
            expect(resultLines[1]).toContain("Failed");
            expect(resultLines[1]).toContain("SMTP authentication was rejected");
            expect(resultLines[2]).toContain("Push notification");
            expect(resultLines[2]).toContain("Unknown");
        });

        mocks.listNotifications.mockResolvedValue([
            {
                notification_id: "sms-1",
                notification_type: "SMS",
                delivery_status: "SENT",
                admin_request_key: "request-1",
                user_id: "worker-1",
                provider_message_id: "sms-provider-1",
                provider_accepted_at: "2025-01-02T03:04:05.000Z",
            },
            {
                notification_id: "email-1",
                notification_type: "EMAIL",
                delivery_status: "FAILED",
                last_error_code: "EMAIL_SMTP_AUTH_FAILED",
                admin_request_key: "request-1",
                user_id: "worker-1",
            },
            {
                notification_id: "push-1",
                notification_type: "PUSH",
                delivery_status: "UNKNOWN",
                admin_request_key: "request-1",
                user_id: "worker-1",
            },
        ]);
        fireEvent.click(screen.getByRole("button", { name: "Refresh delivery statuses" }));
        await waitFor(() => {
            const resultCard = screen.getByRole("heading", { name: "Result" }).closest(".admin-card");
            const resultLines = within(resultCard).getAllByRole("listitem")
                .map((item) => item.textContent)
                .filter((text) => /Text message|Email|Push notification/.test(text));
            expect(resultLines[0]).toContain("Sent");
            expect(resultLines[0]).toContain("Partially sent");
            expect(resultLines[0]).toContain("sms-provider-1");
            expect(resultLines[1]).toContain("Failed");
            expect(resultLines[1]).toContain("SMTP authentication was rejected");
            expect(resultLines[2]).toContain("Unknown");
        });
        const acceptedStatus = screen.getByText("Sent", { selector: ".badge" });
        expect(acceptedStatus).toHaveTextContent("Sent");
    });

    it("previews the complete external message and requires consent before one send", async () => {
        mocks.getExternalSmsAvailability.mockResolvedValue({ enabled: true });
        renderPage();

        const recipient = await screen.findByLabelText("Recipient phone number (E.164)");
        fireEvent.change(recipient, { target: { value: "+254712345678" } });
        fireEvent.change(screen.getByLabelText("Demonstration message"), {
            target: { value: "Hello assessor,\nthis is a demonstration." },
        });
        const consent = screen.getByRole("checkbox", {
            name: "I confirm that this recipient agreed to receive this one-time SMS.",
        });
        expect(screen.getByRole("button", { name: "Preview SMS" })).toBeDisabled();
        fireEvent.click(consent);
        fireEvent.click(screen.getByRole("button", { name: "Preview SMS" }));

        const dialog = await screen.findByRole("dialog", { name: "Review external SMS" });
        expect(dialog).toHaveTextContent("+254712345678");
        expect(dialog).toHaveTextContent("Hello assessor,");
        expect(dialog).toHaveTextContent("this is a demonstration.");
        expect(mocks.sendExternalRecipientSms).not.toHaveBeenCalled();

        const confirm = screen.getByRole("button", { name: "Confirm and send one SMS" });
        fireEvent.click(confirm);
        fireEvent.click(confirm);
        await waitFor(() => expect(mocks.sendExternalRecipientSms).toHaveBeenCalledTimes(1));
        expect(mocks.sendExternalRecipientSms).toHaveBeenCalledWith({
            recipient_phone: "+254712345678",
            message: "Hello assessor,\nthis is a demonstration.",
            recipient_consented: true,
            confirmed: true,
            request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        });
        await waitFor(() => {
            expect(screen.getAllByText(
                "Mobile Sasa accepted the SMS. Delivery is not yet confirmed."
            ).length).toBeGreaterThan(0);
        });
    });

    it("updates a queued email with SMTP acceptance without claiming inbox delivery", async () => {
        mocks.createNotification.mockImplementationOnce(async () => {
            mocks.listNotifications.mockResolvedValue([{
                notification_id: "email-1",
                notification_type: "EMAIL",
                delivery_status: "PROVIDER_ACCEPTED",
                delivery_result: { provider: "GMAIL" },
            }]);
            return [{
                notification_id: "email-1",
                notification_type: "EMAIL",
                delivery_status: "PENDING",
            }];
        });
        renderPage();
        fireEvent.click(await screen.findByLabelText("Akinyi Worker (Worker)"));
        fireEvent.click(screen.getByLabelText("Email"));
        fireEvent.change(screen.getByLabelText("Email subject"), {
            target: { value: "Account update" },
        });
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Your account has an update." },
        });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        fireEvent.click(await screen.findByRole("button", { name: "Confirm and queue" }));

        const resultHeading = await screen.findByRole("heading", { name: "Result" });
        const resultCard = resultHeading.closest(".admin-card");
        expect(await within(resultCard).findByText(/Email.*Sent.*Provider: GMAIL/))
            .toBeInTheDocument();
        expect(await screen.findByText(
            "The provider accepted the message; final delivery is not confirmed."
        )).toBeInTheDocument();
    });

    it("keeps the external recipient form unavailable when the feature flag is off", async () => {
        renderPage();
        expect(await screen.findByText(
            "External-recipient SMS is disabled. Mobile Sasa approval and the required production settings must be in place before it can be used."
        )).toBeInTheDocument();
        expect(screen.queryByLabelText("Recipient phone number (E.164)")).not.toBeInTheDocument();
        expect(mocks.sendExternalRecipientSms).not.toHaveBeenCalled();
    });

    it("keeps composed values when the interface language changes", async () => {
        renderPage();
        fireEvent.click(await screen.findByLabelText("Akinyi Worker (Worker)"));
        fireEvent.click(screen.getByLabelText("SMS"));
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Keep this message" },
        });

        await i18n.changeLanguage("sw");

        expect(screen.getByLabelText("Ujumbe")).toHaveValue("Keep this message");
        expect(screen.getByRole("checkbox", { name: "SMS" })).toBeChecked();
        expect(screen.getByRole("checkbox", { name: "Akinyi Worker (Mfanyakazi)" })).toBeChecked();
    });

    it("shows persisted provider and delivery evidence in both languages", async () => {
        mocks.listNotifications.mockResolvedValue([{
            notification_id: "sms-accepted-1",
            notification_type: "SMS",
            recipient_name: "Akinyi Worker",
            delivery_status: "DELIVERED",
            delivery_result: { provider: "MOBILE_SASA", smsParts: 2 },
            provider_message_id: "provider-reference-1",
            provider_accepted_at: "2026-01-02T03:04:05.000Z",
            delivered_at: "2026-01-02T03:05:05.000Z",
            last_error_code: null,
        }]);
        renderPage();

        fireEvent.click(await screen.findByRole("button", { name: "View" }));
        const details = await screen.findByRole("dialog", { name: "Notification details" });
        expect(within(details).getByText("MOBILE_SASA")).toBeInTheDocument();
        expect(within(details).getByText("provider-reference-1")).toBeInTheDocument();
        expect(within(details).getByText("2", { selector: "p" })).toBeInTheDocument();
        expect(within(details).getByText("Delivery confirmation time:")).toBeInTheDocument();

        await i18n.changeLanguage("sw");
        expect(within(details).getByText("Mtoa huduma:")).toBeInTheDocument();
        expect(within(details).getByText("Kumbukumbu ya mtoa huduma:")).toBeInTheDocument();
        expect(within(details).getByText("Muda wa kuthibitishwa kufika:")).toBeInTheDocument();
    });

    it("previews and queues one announcement for multiple selected users", async () => {
        renderPage();
        fireEvent.click(await screen.findByLabelText("Akinyi Worker (Worker)"));
        fireEvent.click(screen.getByLabelText("Binti Worker (Worker)"));
        fireEvent.click(screen.getByLabelText("SMS"));
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Service update" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));

        const dialog = await screen.findByRole("dialog", { name: "Review before queueing" });
        expect(dialog).toHaveTextContent("Akinyi Worker");
        expect(dialog).toHaveTextContent("Binti Worker");
        fireEvent.click(screen.getByRole("button", { name: "Confirm and queue" }));

        await waitFor(() => {
            expect(mocks.createNotification).toHaveBeenCalledWith(expect.objectContaining({
                user_ids: ["worker-1", "worker-2"],
                channels: ["SMS"],
                message: "Service update",
            }));
        });
    });

    it("reports skipped recipient contacts and makes clear that queueing is not delivery", async () => {
        mocks.createNotification.mockResolvedValue([{
            notification_id: "skipped-worker-1-SMS",
            notification_type: "SMS",
            recipient_name: "Akinyi Worker",
            delivery_status: "SKIPPED",
            last_error_code: "NOTIFICATION_PHONE_UNVERIFIED",
        }]);
        renderPage();
        fireEvent.click(await screen.findByLabelText("Akinyi Worker (Worker)"));
        fireEvent.click(screen.getByLabelText("SMS"));
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Service update" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        fireEvent.click(await screen.findByRole("button", { name: "Confirm and queue" }));

        expect(await screen.findByText(/Skipped — Registered phone number is not verified/))
            .toBeInTheDocument();
        expect(await screen.findByText(
            "Notification request queued. Check each channel's status below; queueing does not confirm delivery."
        )).toBeInTheDocument();
    });

    it("lets administrators opt in to push on their own authenticated device", async () => {
        renderPage();

        expect(await screen.findByRole("heading", { name: "Browser notifications" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enable browser notifications" })).toBeInTheDocument();
    });

    it("previews the fixed self-test message and only queues after explicit confirmation", async () => {
        renderPage();

        fireEvent.click(await screen.findByRole("button", { name: "Preview test SMS" }));
        const dialog = await screen.findByRole("dialog", { name: "Review your test SMS" });
        expect(dialog).toHaveTextContent("Your registered administrator phone number");
        expect(dialog).toHaveTextContent(
            "MicoPesa test notification: Your SMS notification service is working. This is a test message. No payment has been made."
        );
        expect(mocks.sendAdminTestSms).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm test SMS" }));
        await waitFor(() => {
            expect(mocks.sendAdminTestSms).toHaveBeenCalledWith(
                "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5"
            );
        });
        expect(await screen.findByText("Pending", { selector: ".badge" })).toBeInTheDocument();
        expect(await screen.findByText(/Queued and waiting for the dispatcher/)).toBeInTheDocument();

        mocks.listNotifications.mockResolvedValue([{
            notification_id: "test-sms-1",
            notification_type: "SMS",
            delivery_status: "PROVIDER_ACCEPTED",
            delivery_result: { provider: "MOBILE_SASA" },
        }]);
        fireEvent.click(screen.getByRole("button", { name: "Refresh delivery statuses" }));
        expect(await screen.findByText(/Accepted by Mobile Sasa; final delivery has not been confirmed/))
            .toBeInTheDocument();

        mocks.listNotifications.mockResolvedValue([{
            notification_id: "test-sms-1",
            notification_type: "SMS",
            delivery_status: "DELIVERED",
            delivery_result: { provider: "MOBILE_SASA" },
        }]);
        fireEvent.click(screen.getByRole("button", { name: "Refresh delivery statuses" }));
        expect(await screen.findByText("Delivery was confirmed by the provider.")).toBeInTheDocument();
    });

    it("labels failed and unknown outcomes distinctly instead of reporting success", async () => {
        mocks.sendAdminTestSms.mockResolvedValueOnce([{
            notification_id: "test-sms-failed",
            notification_type: "SMS",
            delivery_status: "FAILED",
        }]);
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: "Preview test SMS" }));
        fireEvent.click(await screen.findByRole("button", { name: "Confirm test SMS" }));

        expect(await screen.findByText("Failed", { selector: ".badge" })).toBeInTheDocument();
        expect(await screen.findByRole("alert")).toHaveTextContent("The test SMS failed.");

        cleanup();
        mocks.listNotifications.mockResolvedValue([]);
        mocks.sendAdminTestSms.mockResolvedValueOnce([{
            notification_id: "test-sms-unknown",
            notification_type: "SMS",
            delivery_status: "UNKNOWN",
        }]);
        renderPage();
        fireEvent.click(await screen.findByRole("button", { name: "Preview test SMS" }));
        fireEvent.click(await screen.findByRole("button", { name: "Confirm test SMS" }));

        expect(await screen.findByText("Unknown", { selector: ".badge" })).toBeInTheDocument();
        expect(await screen.findByText(
            "The provider outcome is unknown. The test SMS will not be resent automatically."
        )).toBeInTheDocument();
    });
});
