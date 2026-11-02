import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateMyProfile } from "./profileApi";

const mocks = vi.hoisted(() => ({ patch: vi.fn() }));

vi.mock("./api", () => ({
    default: { patch: mocks.patch },
}));

describe("updateMyProfile partial requests", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.patch.mockResolvedValue({ data: { data: { user: { user_id: "user-1" } } } });
    });

    it("sends only the full name when saving a name edit", async () => {
        await updateMyProfile({ full_name: "Amina Wanjiku" });

        expect(mocks.patch).toHaveBeenCalledWith("/api/profile/me", {
            full_name: "Amina Wanjiku",
        });
    });

    it("sends only the email when saving an email edit", async () => {
        await updateMyProfile({ email: "amina@example.com" });

        expect(mocks.patch).toHaveBeenCalledWith("/api/profile/me", {
            email: "amina@example.com",
        });
    });
});
