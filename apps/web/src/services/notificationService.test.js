import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import {
    getMyNotificationPreferences,
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
            data: { data: { email_enabled: true, sms_enabled: false } },
        });

        await expect(getMyNotificationPreferences()).resolves.toEqual({
            email_enabled: true,
            sms_enabled: false,
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
});
