import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import RoleNotifications from "./RoleNotifications";

const mocks = vi.hoisted(() => ({
    createRoleNotification: vi.fn(),
    listNotificationAudit: vi.fn(),
    listRoleNotificationRecipients: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/notificationService", () => ({
    createRoleNotification: mocks.createRoleNotification,
    listNotificationAudit: mocks.listNotificationAudit,
    listRoleNotificationRecipients: mocks.listRoleNotificationRecipients,
}));
vi.mock("../../context/AuthContext", () => ({
    useAuth: mocks.useAuth,
}));

describe("role-scoped notifications", () => {
    let originalCrypto;

    beforeEach(() => {
        vi.clearAllMocks();
        i18n.changeLanguage("en");
        originalCrypto = Object.getOwnPropertyDescriptor(window, "crypto");
        Object.defineProperty(window, "crypto", {
            configurable: true,
            value: { randomUUID: () => "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5" },
        });
        mocks.useAuth.mockReturnValue({ user: { role: "FUND_MANAGER" } });
        mocks.listRoleNotificationRecipients.mockResolvedValue([{
            user_id: "worker-1",
            full_name: "Worker One",
            role: "WORKER",
            phone_available: true,
            email_available: true,
            push_subscription_count: 1,
            scope_fund_id: "fund-1",
        }]);
        mocks.listNotificationAudit.mockResolvedValue([]);
        mocks.createRoleNotification.mockResolvedValue([]);
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
        if (originalCrypto) Object.defineProperty(window, "crypto", originalCrypto);
    });

    it("keeps the recipient in fund scope and previews before queuing", async () => {
        render(<ToastProvider><RoleNotifications /></ToastProvider>);

        fireEvent.change(await screen.findByLabelText("Recipient"), {
            target: { value: "worker-1" },
        });
        fireEvent.click(screen.getByLabelText("SMS"));
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Please review your contribution." },
        });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        expect(await screen.findByRole("dialog", { name: "Review notification" }))
            .toHaveTextContent("Worker One");
        expect(mocks.createRoleNotification).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole("button", { name: "Confirm and queue" }));
        await waitFor(() => expect(mocks.createRoleNotification).toHaveBeenCalledWith({
            user_id: "worker-1",
            fund_id: "fund-1",
            category: "CONTRIBUTION_REMINDER",
            channels: ["SMS"],
            message: "Please review your contribution.",
            request_id: "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5",
        }));
        await waitFor(() => expect(mocks.listNotificationAudit).toHaveBeenCalledTimes(2));
    });

    it("preserves composed message values when switching language", async () => {
        render(<ToastProvider><RoleNotifications /></ToastProvider>);
        fireEvent.change(await screen.findByLabelText("Recipient"), {
            target: { value: "worker-1" },
        });
        fireEvent.change(screen.getByLabelText("Message"), {
            target: { value: "Keep this message" },
        });

        await i18n.changeLanguage("sw");

        expect(screen.getByLabelText("Ujumbe")).toHaveValue("Keep this message");
        expect(screen.getByRole("combobox", { name: "Mpokeaji" })).toHaveValue("worker-1");
    });

    it("limits regulator categories and shows the regulatory notification heading", async () => {
        mocks.useAuth.mockReturnValue({ user: { role: "REGULATOR" } });
        render(<ToastProvider><RoleNotifications /></ToastProvider>);

        expect(await screen.findByRole("heading", { name: "Regulatory notifications" }))
            .toBeInTheDocument();
        const categorySelect = screen.getByLabelText("Notification category");
        expect(categorySelect.querySelectorAll("option")).toHaveLength(4);
        expect(screen.queryByRole("option", { name: "Scheme update" })).not.toBeInTheDocument();
    });
});
