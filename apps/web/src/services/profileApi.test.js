import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMyProfile, updateMyProfile } from "./profileApi";

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));

vi.mock("./api", () => ({
    default: { get: mocks.get, patch: mocks.patch },
}));

describe("getMyProfile", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.get.mockResolvedValue({
            data: {
                data: {
                    user: {
                        user_id: "user-1",
                        date_of_birth: "1990-04-15",
                        masked_national_id: "****1234",
                        kyc_status: "PENDING",
                    },
                },
            },
        });
    });

    it("returns the API's masked KYC profile fields without exposing a full National ID", async () => {
        const user = await getMyProfile();

        expect(mocks.get).toHaveBeenCalledWith("/api/profile/me");
        expect(user).toEqual({
            user_id: "user-1",
            date_of_birth: "1990-04-15",
            masked_national_id: "****1234",
            kyc_status: "PENDING",
        });
        expect(user).not.toHaveProperty("national_id");
    });
});

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
