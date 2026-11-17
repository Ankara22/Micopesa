import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import {
    getMyNotificationPreferences,
    listNotificationAudit,
    updateMyNotificationPreferences,
} from "./notificationService";

vi.mock("./api", () => ({
    default: {
        get: vi.fn(),
        patch: vi.fn(),
    },
}));

describe("notification preference API", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("loads only the current user's boolean email and SMS preferences", async () => {
        api.get.mockResolvedValue({
            data: { data: {
                email_enabled: true,
                sms_enabled: false,
                phone_registered: true,
                phone_verified: false,
                email_registered: true,
                email_verified: true,
                push_enabled: true,
                phone: "must-not-be-returned",
            } },
        });

        await expect(getMyNotificationPreferences()).resolves.toEqual({
            email_enabled: true,
            sms_enabled: false,
            phone_registered: true,
            phone_verified: false,
            email_registered: true,
            email_verified: true,
            push_enabled: true,
        });
        expect(api.get).toHaveBeenCalledWith("/api/notifications/preferences");
    });

    it("updates the current user's channel preferences without a user identifier", async () => {
        api.patch.mockResolvedValue({
            data: { data: { email_enabled: false, sms_enabled: true } },
        });

        await expect(updateMyNotificationPreferences({
            email_enabled: false,
            sms_enabled: true,
        })).resolves.toEqual({
            email_enabled: false,
            sms_enabled: true,
        });
        expect(api.patch).toHaveBeenCalledWith("/api/notifications/preferences", {
            email_enabled: false,
            sms_enabled: true,
        });
    });

    it("rejects malformed preference responses and non-boolean updates", async () => {
        api.get.mockResolvedValue({ data: { data: { email_enabled: "yes", sms_enabled: false } } });
        await expect(getMyNotificationPreferences())
            .rejects.toMatchObject({ code: "INVALID_NOTIFICATION_PREFERENCES" });
        await expect(updateMyNotificationPreferences({
            email_enabled: true,
            sms_enabled: "yes",
        })).rejects.toThrow("Only boolean SMS and email preferences may be updated.");
        await expect(updateMyNotificationPreferences({
            email_enabled: true,
            user_id: "another-user",
        })).rejects.toThrow("Only boolean SMS and email preferences may be updated.");
        expect(api.patch).not.toHaveBeenCalled();
    });

    it("requires a complete audit response instead of treating a failed shape as empty", async () => {
        api.get.mockResolvedValue({
            data: {
                data: [{ audit_event_id: "audit-1" }],
                pagination: { page: 1, total_pages: 1 },
                summary: { total_count: 1, authorized_count: 1, denied_count: 0 },
            },
        });
        await expect(listNotificationAudit()).resolves.toEqual({
            records: [{ audit_event_id: "audit-1" }],
            pagination: { page: 1, total_pages: 1 },
            summary: { total_count: 1, authorized_count: 1, denied_count: 0 },
        });

        api.get.mockResolvedValue({ data: { data: undefined } });
        await expect(listNotificationAudit())
            .rejects.toThrow("The notification audit response was incomplete.");
    });
});
