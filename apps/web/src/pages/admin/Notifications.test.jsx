import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import Notifications from "./Notifications";

const mocks = vi.hoisted(() => ({
    createNotification: vi.fn(),
    listNotificationRecipients: vi.fn(),
    listNotifications: vi.fn(),
    getMyNotificationPreferences: vi.fn(),
    updateMyNotificationPreferences: vi.fn(),
}));

vi.mock("../../services/adminService", () => ({
    createNotification: mocks.createNotification,
    listNotificationRecipients: mocks.listNotificationRecipients,
    listNotifications: mocks.listNotifications,
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

async function selectRecipient(label) {
    fireEvent.click(await screen.findByRole("button", {
        name: "Search and select registered users",
    }));
    fireEvent.click(await screen.findByLabelText(label));
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
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "worker-1",
            full_name: "Akinyi Worker",
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: true,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: true,
            email_delivery_enabled: true,
            push_subscription_count: 1,
            push_delivery_enabled: true,
        }, {
            user_id: "worker-2",
            full_name: "Binti Worker",
            role: "WORKER",
            phone_registered: false,
            phone_verified: false,
            phone_available: false,
            sms_enabled: true,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: true,
            email_delivery_enabled: true,
            push_subscription_count: 0,
            push_delivery_enabled: false,
        }]);
        mocks.createNotification.mockResolvedValue([
            { notification_id: "sms-1", notification_type: "SMS", delivery_status: "PENDING" },
            { notification_id: "email-1", notification_type: "EMAIL", delivery_status: "PENDING" },
            { notification_id: "push-1", notification_type: "PUSH", delivery_status: "PENDING" },
        ]);
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

        await selectRecipient("Akinyi Worker (Worker)");
        fireEvent.click(screen.getByRole("button", { name: "Search and select registered users" }));
        fireEvent.change(screen.getByLabelText("Search by name or account ID"), {
            target: { value: "Akinyi" },
        });

        await waitFor(() => {
            expect(mocks.listNotificationRecipients).toHaveBeenLastCalledWith("Akinyi");
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
        expect(dialog).toHaveTextContent("verified email on file");
        expect(dialog).toHaveTextContent("verified phone on file");
        expect(dialog).not.toHaveTextContent("worker@example.test");
        expect(dialog).not.toHaveTextContent("0712345678");
        expect(dialog).toHaveTextContent("Your contribution was recorded.");
        expect(dialog).toHaveTextContent("Hello member");
        expect(dialog).not.toHaveTextContent("alert(1)");
        expect(dialog).toHaveTextContent("Preview only: nothing is queued or sent");
        expect(mocks.createNotification).not.toHaveBeenCalled();

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

    it("shows user eligibility separately from exact system and provider configuration blockers", async () => {
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "worker-1",
            full_name: "Akinyi Worker",
            role: "WORKER",
            phone_registered: true,
            phone_verified: false,
            sms_enabled: false,
            sms_delivery_enabled: false,
            sms_delivery_diagnostic: {
                reason_code: "system_delivery_disabled",
                missing_variables: ["MOBILESASA_NOTIFICATION_SMS_ENABLED"],
                disabled_variables: [],
                invalid_variables: [],
            },
            email_registered: true,
            email_verified: true,
            email_enabled: true,
            email_delivery_enabled: false,
            email_delivery_diagnostic: {
                reason_code: "system_delivery_disabled",
                missing_variables: [],
                disabled_variables: ["COMMUNICATIONS_DEV_EMAIL_ENABLED"],
                invalid_variables: [],
            },
            push_subscription_count: 0,
            push_delivery_enabled: false,
            push_delivery_diagnostic: {
                reason_code: "environment_unsupported",
                missing_variables: [],
                invalid_variables: ["NODE_ENV"],
            },
        }]);
        renderPage();

        await selectRecipient("Akinyi Worker (Worker)");
        const diagnostics = screen.getByLabelText("Selected recipient channel availability");
        expect(diagnostics).toHaveTextContent("Registered phone number is not verified");
        expect(diagnostics).toHaveTextContent(
            "System-level delivery for this channel is disabled"
        );
        expect(diagnostics).toHaveTextContent("MOBILESASA_NOTIFICATION_SMS_ENABLED");
        expect(diagnostics).toHaveTextContent("System-level delivery for this channel is disabled");
        expect(diagnostics).toHaveTextContent("No registered push subscription");
        expect(diagnostics).toHaveTextContent("This channel is not supported in the current environment");
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
        await selectRecipient("Akinyi Worker (Worker)");
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

    it("keeps composed values when the interface language changes", async () => {
        renderPage();
        await selectRecipient("Akinyi Worker (Worker)");
        fireEvent.click(screen.getByLabelText("SMS"));
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Keep this message" },
        });

        await i18n.changeLanguage("sw");

        expect(screen.getByLabelText("Ujumbe")).toHaveValue("Keep this message");
        expect(screen.getByRole("checkbox", { name: "SMS" })).toBeChecked();
        expect(screen.getByRole("button", { name: "Ondoa Akinyi Worker" })).toBeInTheDocument();
    });

    it("searches, selects, removes, and limits registered recipients in the dropdown", async () => {
        const recipients = Array.from({ length: 101 }, (_, index) => ({
            user_id: `worker-${index + 1}`,
            full_name: `Worker ${index + 1}`,
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: true,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: true,
            email_delivery_enabled: true,
            push_subscription_count: 0,
            push_delivery_enabled: false,
        }));
        mocks.listNotificationRecipients.mockResolvedValue(recipients);
        renderPage();

        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
        fireEvent.click(await screen.findByRole("button", {
            name: "Search and select registered users",
        }));
        expect(screen.getByRole("listbox")).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Search by name or account ID"), {
            target: { value: "Worker 1" },
        });
        await waitFor(() => {
            expect(mocks.listNotificationRecipients).toHaveBeenLastCalledWith("Worker 1");
        });
        fireEvent.change(screen.getByLabelText("Search by name or account ID"), {
            target: { value: "" },
        });
        await waitFor(() => {
            expect(mocks.listNotificationRecipients).toHaveBeenLastCalledWith("");
        });
        fireEvent.click(screen.getByRole("button", { name: "Search and select registered users" }));
        await selectRecipient("Worker 1 (Worker)");
        await selectRecipient("Worker 2 (Worker)");

        expect(screen.getByText("2 recipient(s) selected (maximum 100).")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Remove Worker 1" }));
        expect(screen.getByText("1 recipient(s) selected (maximum 100).")).toBeInTheDocument();

        for (let index = 3; index <= 101; index += 1) {
            fireEvent.click(screen.getByRole("button", {
                name: "Search and select registered users",
            }));
            fireEvent.click(screen.getByLabelText(`Worker ${index} (Worker)`));
        }
        expect(screen.getByText("100 recipient(s) selected (maximum 100).")).toBeInTheDocument();
        await selectRecipient("Worker 1 (Worker)");
        expect(screen.getByRole("alert")).toHaveTextContent(
            "You can select up to 100 recipients per announcement."
        );
    }, 60000);

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

    it("explains why channels are unavailable for a newly registered unverified user", async () => {
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "new-worker",
            full_name: "New Worker",
            role: "WORKER",
            phone_registered: true,
            phone_verified: false,
            phone_available: false,
            sms_enabled: true,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: false,
            email_available: false,
            email_enabled: true,
            email_delivery_enabled: true,
            push_subscription_count: 0,
        }]);
        renderPage();

        await selectRecipient("New Worker (Worker)");

        expect(screen.getByLabelText("SMS")).toBeDisabled();
        expect(screen.getByLabelText("Email")).toBeDisabled();
        expect(screen.getByText(/Registered phone number is not verified/)).toBeInTheDocument();
        expect(screen.getByText(/Registered email address is not verified/)).toBeInTheDocument();
    });

    it("allows verified SMS and email without development recipient allowlists", async () => {
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "worker-outside-email-allowlist",
            full_name: "Worker Outside Email Allowlist",
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: true,
            sms_delivery_enabled: true,
            sms_recipient_allowed: false,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: true,
            email_delivery_enabled: true,
            email_recipient_allowed: false,
            push_subscription_count: 0,
            push_delivery_enabled: false,
        }]);
        renderPage();

        await selectRecipient("Worker Outside Email Allowlist (Worker)");

        expect(screen.getByLabelText("SMS")).toBeEnabled();
        expect(screen.getByLabelText("Email")).toBeEnabled();
        expect(screen.getByLabelText("Selected recipient channel availability"))
            .toHaveTextContent("Email — verified email on file");
    });

    it("prevents Admin from sending optional notifications to contacts that opted out", async () => {
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "opted-out-worker",
            full_name: "Opted Out Worker",
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: false,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: false,
            email_delivery_enabled: true,
            push_subscription_count: 0,
        }]);
        renderPage();

        await selectRecipient("Opted Out Worker (Worker)");

        expect(screen.getByLabelText("SMS")).toBeDisabled();
        expect(screen.getByLabelText("Email")).toBeDisabled();
        expect(screen.getAllByText(/notification preferences/)).toHaveLength(2);
    });

    it("allows verified contacts for essential operational notifications despite optional opt-out", async () => {
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "essential-worker",
            full_name: "Essential Worker",
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: false,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: false,
            email_delivery_enabled: true,
            push_subscription_count: 0,
        }]);
        renderPage();

        await selectRecipient("Essential Worker (Worker)");
        fireEvent.change(screen.getByLabelText("Notification category"), {
            target: { value: "ACCOUNT_SERVICE" },
        });

        expect(screen.getByLabelText("SMS")).toBeEnabled();
        expect(screen.getByLabelText("Email")).toBeEnabled();
        expect(screen.getByText(/SMS — verified phone on file/)).toBeInTheDocument();
        expect(screen.getByText(/Email — verified email on file/)).toBeInTheDocument();
        expect(screen.queryByText(/notification preferences/)).not.toBeInTheDocument();
    });

    it("explains when verified and opted-in channels are disabled by system configuration", async () => {
        mocks.listNotificationRecipients.mockResolvedValue([{
            user_id: "worker-with-disabled-providers",
            full_name: "Worker With Disabled Providers",
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: true,
            sms_delivery_enabled: false,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: true,
            email_delivery_enabled: false,
            push_subscription_count: 0,
        }]);
        renderPage();

        await selectRecipient("Worker With Disabled Providers (Worker)");

        expect(screen.getByLabelText("SMS")).toBeDisabled();
        expect(screen.getByLabelText("Email")).toBeDisabled();
        expect(screen.getByText(/SMS delivery is disabled by system configuration/)).toBeInTheDocument();
        expect(screen.getByText(/Email delivery is disabled by system configuration/)).toBeInTheDocument();
    });

    it("refreshes recipient diagnostics and replaces stale channel availability", async () => {
        const refreshedRecipient = {
            user_id: "worker-1",
            full_name: "Akinyi Worker",
            role: "WORKER",
            phone_registered: true,
            phone_verified: true,
            phone_available: true,
            sms_enabled: true,
            sms_delivery_enabled: true,
            email_registered: true,
            email_verified: true,
            email_available: true,
            email_enabled: true,
            email_delivery_enabled: false,
            email_delivery_diagnostic: {
                reason_code: "system_delivery_disabled",
                missing_variables: [],
                disabled_variables: ["COMMUNICATIONS_DEV_EMAIL_ENABLED"],
                invalid_variables: [],
            },
            push_subscription_count: 1,
            push_delivery_enabled: true,
        };
        mocks.listNotificationRecipients
            .mockResolvedValueOnce([{
                ...refreshedRecipient,
                email_delivery_enabled: true,
                email_delivery_diagnostic: { reason_code: null },
            }])
            .mockResolvedValueOnce([refreshedRecipient]);
        renderPage();

        await selectRecipient("Akinyi Worker (Worker)");
        expect(screen.getByLabelText("Email")).toBeEnabled();

        fireEvent.click(screen.getByRole("button", { name: "Refresh recipient diagnostics" }));

        await waitFor(() => {
            expect(mocks.listNotificationRecipients).toHaveBeenCalledTimes(2);
            expect(screen.getByLabelText("Email")).toBeDisabled();
            expect(screen.getByLabelText("Selected recipient channel availability"))
                .toHaveTextContent("System-level delivery for this channel is disabled");
        });
    });

    it("fails closed when refreshed recipient diagnostics return an API error", async () => {
        mocks.listNotificationRecipients
            .mockResolvedValueOnce([{
                user_id: "worker-1",
                full_name: "Akinyi Worker",
                role: "WORKER",
                phone_registered: true,
                phone_verified: true,
                phone_available: true,
                sms_enabled: true,
                sms_delivery_enabled: true,
                email_registered: true,
                email_verified: true,
                email_available: true,
                email_enabled: true,
                email_delivery_enabled: true,
                push_subscription_count: 1,
                push_delivery_enabled: true,
            }])
            .mockRejectedValueOnce({ message: "Request failed" });
        renderPage();

        await selectRecipient("Akinyi Worker (Worker)");
        fireEvent.click(screen.getByRole("button", { name: "Refresh recipient diagnostics" }));

        await waitFor(() => {
            expect(screen.getByLabelText("Email")).toBeDisabled();
            expect(screen.getByLabelText("Selected recipient channel availability"))
                .toHaveTextContent("Recipient delivery diagnostics are unavailable or stale");
        });
        expect(screen.getByRole("alert"))
            .toHaveTextContent("Recipient delivery diagnostics are unavailable or stale");
    });

    it("maps normalized API errors to the exact system-disabled reason", async () => {
        mocks.createNotification.mockRejectedValue({
            data: { code: "NOTIFICATION_SYSTEM_DELIVERY_DISABLED" },
        });
        renderPage();

        await selectRecipient("Akinyi Worker (Worker)");
        fireEvent.click(screen.getByLabelText("Email"));
        fireEvent.change(screen.getByLabelText("Email subject"), {
            target: { value: "Account update" },
        });
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Your account has an update." },
        });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        fireEvent.click(await screen.findByRole("button", { name: "Confirm and queue" }));

        expect(await screen.findByText("System-level delivery for this channel is disabled"))
            .toBeInTheDocument();
    });

    it("previews and queues one announcement for multiple selected users", async () => {
        renderPage();
        await selectRecipient("Akinyi Worker (Worker)");
        await selectRecipient("Binti Worker (Worker)");
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
        await selectRecipient("Akinyi Worker (Worker)");
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

    it("shows transactional event policy separately from optional admin notifications", async () => {
        mocks.listNotifications.mockResolvedValue([{
            notification_id: "transactional-notification-1",
            user_id: "worker-1",
            recipient_name: "Worker One",
            notification_category: "ACCOUNT_SERVICE",
            notification_event_type: "CONTRIBUTION_CONFIRMED",
            notification_type: "IN_APP",
            message: "Your contribution has been confirmed.",
            delivery_status: "PENDING",
            created_at: "2026-01-01T00:00:00.000Z",
        }]);
        renderPage();

        const card = (await screen.findByText("Your contribution has been confirmed."))
            .closest(".notification-message-card");
        fireEvent.click(within(card).getByRole("button", { name: "View" }));

        const dialog = await screen.findByRole("dialog", { name: "Notification details" });
        expect(dialog).toHaveTextContent(
            "Essential transactional event (CONTRIBUTION_CONFIRMED); active account and verified contact required."
        );
    });

    it("lets administrators opt in to push on their own authenticated device", async () => {
        renderPage();

        expect(await screen.findByRole("heading", { name: "Browser notifications" })).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Enable browser notifications" })).toBeInTheDocument();
    });

});
