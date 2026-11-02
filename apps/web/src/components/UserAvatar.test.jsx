import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import UserAvatar from "./UserAvatar";

const mocks = vi.hoisted(() => ({ getMyProfilePhoto: vi.fn() }));

vi.mock("../services/profileApi", () => ({
    getMyProfilePhoto: mocks.getMyProfilePhoto,
}));

const user = {
    user_id: "user-1",
    full_name: "Amina Worker",
    updated_at: "2026-10-26T14:00:00Z",
    profile_photo_available: true,
};

describe("UserAvatar photo feedback", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("shows a loading indicator and then displays the authenticated photo", async () => {
        let resolvePhoto;
        mocks.getMyProfilePhoto.mockReturnValue(new Promise((resolve) => {
            resolvePhoto = resolve;
        }));
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = vi.fn(() => "blob:avatar");
        URL.revokeObjectURL = vi.fn();

        try {
            const { container } = render(<UserAvatar user={user} />);
            expect(screen.getByRole("img", { name: "Loading Amina Worker's profile photo" }))
                .toHaveAttribute("aria-busy", "true");
            expect(container.querySelector(".user-avatar-progress")).toBeInTheDocument();

            resolvePhoto(new Blob(["image"], { type: "image/png" }));
            await waitFor(() => expect(container.querySelector(".user-avatar img")).toHaveAttribute("src", "blob:avatar"));
            expect(screen.getByRole("img", { name: "Amina Worker profile photo" }))
                .not.toHaveAttribute("aria-busy");
            expect(mocks.getMyProfilePhoto).toHaveBeenCalledTimes(1);
        } finally {
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    it("uses initials when photo retrieval fails without retrying on rerender", async () => {
        mocks.getMyProfilePhoto.mockRejectedValue({ status: 500, message: "Photo unavailable" });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        try {
            const { rerender } = render(<UserAvatar user={user} />);
            expect(await screen.findByRole("img", { name: "Amina Worker profile photo" })).toHaveTextContent("AW");
            rerender(<UserAvatar user={{ ...user }} />);
            expect(mocks.getMyProfilePhoto).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });

    it("falls back to initials if a downloaded image cannot be rendered", async () => {
        mocks.getMyProfilePhoto.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = vi.fn(() => "blob:broken-avatar");
        URL.revokeObjectURL = vi.fn();

        try {
            const { container } = render(<UserAvatar user={user} />);
            const image = await waitFor(() => {
                const loaded = container.querySelector(".user-avatar img");
                expect(loaded).toBeInTheDocument();
                return loaded;
            });
            fireEvent.error(image);
            expect(screen.getByRole("img", { name: "Amina Worker profile photo" })).toHaveTextContent("AW");
            expect(mocks.getMyProfilePhoto).toHaveBeenCalledTimes(1);
        } finally {
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });
});
