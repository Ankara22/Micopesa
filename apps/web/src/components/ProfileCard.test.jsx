import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import ProfileCard from "./ProfileCard";
import Header from "../layouts/Header";

const mocks = vi.hoisted(() => ({
    getMyProfile: vi.fn(),
    updateMyProfile: vi.fn(),
    requestPhoneChange: vi.fn(),
    verifyPhoneChange: vi.fn(),
    uploadMyProfilePhoto: vi.fn(),
    getMyProfilePhoto: vi.fn(),
    beginProfileRequest: vi.fn(),
    isProfileRequestCurrent: vi.fn(),
    syncProfile: vi.fn(),
    user: null,
}));

vi.mock("../services/profileApi", () => ({
    getMyProfile: mocks.getMyProfile,
    getMyProfilePhoto: mocks.getMyProfilePhoto,
    updateMyProfile: mocks.updateMyProfile,
    requestPhoneChange: mocks.requestPhoneChange,
    verifyPhoneChange: mocks.verifyPhoneChange,
    uploadMyProfilePhoto: mocks.uploadMyProfilePhoto,
}));
vi.mock("../context/AuthContext", () => ({
    useAuth: () => ({
        user: mocks.user,
        loginSessionId: 1,
        beginProfileRequest: mocks.beginProfileRequest,
        isProfileRequestCurrent: mocks.isProfileRequestCurrent,
        syncProfile: mocks.syncProfile,
        logout: vi.fn(),
    }),
}));

const profile = {
    user_id: "user-1",
    full_name: "Amina Worker",
    email: "amina@example.com",
    phone: "254700000001",
    role: "WORKER",
    occupation: "MARKET_VENDOR",
    account_status: "ACTIVE",
    date_of_birth: "1990-04-15",
    masked_national_id: "****1234",
    kyc_status: "PENDING",
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2026-10-26T00:00:00.000Z",
    profile_photo_available: false,
};

function renderProfile({ includeHeader = false } = {}) {
    return render(
        <MemoryRouter>
            {includeHeader && <Header />}
            <ProfileCard />
        </MemoryRouter>
    );
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("shared ProfileCard", () => {
    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.user = { ...profile };
        mocks.beginProfileRequest.mockReturnValue({
            userId: "user-1",
            token: "token-1",
            generation: 1,
            requestId: 1,
        });
        mocks.isProfileRequestCurrent.mockReturnValue(true);
        mocks.syncProfile.mockImplementation((savedProfile, _request, options) => {
            mocks.user = {
                ...mocks.user,
                ...savedProfile,
                ...(options?.photoUpdated && {
                    profile_photo_version: (mocks.user.profile_photo_version || 0) + 1,
                }),
            };
            return true;
        });
        mocks.getMyProfile.mockResolvedValue(profile);
        mocks.updateMyProfile.mockImplementation(async (updates) => ({ ...profile, ...updates }));
        mocks.requestPhoneChange.mockResolvedValue({
            phone: "+254712345678",
            expiresAt: "2026-11-05T12:10:00.000Z",
        });
        mocks.verifyPhoneChange.mockResolvedValue({
            phone: "+254712345678",
            phoneVerified: true,
        });
        mocks.uploadMyProfilePhoto.mockResolvedValue({ ...profile, profile_photo_available: true });
        mocks.getMyProfilePhoto.mockRejectedValue({ status: 404 });
    });

    it("opens the native file picker from the initials avatar", async () => {
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
        fireEvent.click(screen.getByRole("button", { name: "Change profile photo" }));
        expect(click).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("img", { name: "Amina Worker profile photo" })).toHaveTextContent("AW");
        click.mockRestore();
    });

    it("translates the worker profile while keeping personal data unchanged", async () => {
        await i18n.changeLanguage("sw");
        renderProfile();

        expect(await screen.findByRole("heading", { name: "Amina Worker" })).toBeInTheDocument();
        expect(screen.getByText("Taarifa binafsi")).toBeInTheDocument();
        expect(screen.getByText("Muuza bidhaa sokoni")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Badilisha picha ya wasifu" })).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Hariri jina kamili" }));
        expect(screen.getByLabelText("Jina kamili")).toHaveValue("Amina Worker");
        expect(screen.getByRole("button", { name: "Hifadhi" })).toBeInTheDocument();
    });

    it("shows date of birth, masked National ID, and pending KYC status without a full ID", async () => {
        const { container } = renderProfile();

        await screen.findByRole("heading", { name: "Amina Worker" });
        expect(screen.getByText("Date of birth")).toBeInTheDocument();
        expect(screen.getByText(/1990/)).toBeInTheDocument();
        expect(screen.getByText("National ID")).toBeInTheDocument();
        expect(screen.getByText("****1234")).toBeInTheDocument();
        expect(screen.getByText("KYC verification status")).toBeInTheDocument();
        expect(screen.getByText("Pending verification")).toBeInTheDocument();
        expect(container).not.toHaveTextContent("12345678");
    });

    it("shows a graceful fallback when no KYC record is available", async () => {
        mocks.getMyProfile.mockResolvedValueOnce({
            ...profile,
            date_of_birth: null,
            masked_national_id: null,
            kyc_status: null,
        });
        renderProfile();

        await screen.findByRole("heading", { name: "Amina Worker" });
        expect(screen.getByText("Date of birth").parentElement).toHaveTextContent("Not provided");
        expect(screen.getByText("National ID").parentElement).toHaveTextContent("Not provided");
        expect(screen.getByText("KYC verification status").parentElement).toHaveTextContent("Not provided");
    });

    it("requires explicit confirmation, sends a code, and refreshes the profile after verification", async () => {
        mocks.getMyProfile
            .mockResolvedValueOnce(profile)
            .mockResolvedValue({ ...profile, phone: "+254712345678" });
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        expect(screen.getByText("Current registered number:")).toBeInTheDocument();
        expect(screen.getByText("254700000001")).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("New Kenyan mobile number"), {
            target: { value: "0712 345 678" },
        });
        fireEvent.change(screen.getByLabelText("Current password"), {
            target: { value: "current-password" },
        });
        const sendButton = screen.getByRole("button", { name: "Send verification code" });
        expect(sendButton).toBeDisabled();
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(sendButton);

        expect(await screen.findByLabelText("Verification code")).toBeInTheDocument();
        expect(mocks.requestPhoneChange).toHaveBeenCalledWith({
            newPhone: "0712 345 678",
            currentPassword: "current-password",
            confirmed: true,
        });
        fireEvent.change(screen.getByLabelText("Verification code"), {
            target: { value: "123456" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Verify and change number" }));

        expect(await screen.findByRole("status")).toHaveTextContent(
            "Your phone number is verified and updated"
        );
        expect(mocks.verifyPhoneChange).toHaveBeenCalledWith("123456");
        expect(mocks.getMyProfile).toHaveBeenCalledTimes(2);
        expect(screen.getByText("+254712345678")).toBeInTheDocument();
    });

    it("uploads a valid selected image immediately and updates the avatar", async () => {
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = vi.fn(() => "blob:updated-avatar");
        URL.revokeObjectURL = vi.fn();
        mocks.getMyProfilePhoto.mockResolvedValue(new Blob(["image"], { type: "image/png" }));

        try {
            renderProfile();
            await screen.findByRole("heading", { name: "Amina Worker" });
            const image = new File(["image"], "profile.png", { type: "image/png" });
            fireEvent.change(screen.getByLabelText("Choose profile photo"), { target: { files: [image] } });

            await waitFor(() => expect(mocks.uploadMyProfilePhoto).toHaveBeenCalledWith(image));
            await waitFor(() => expect(screen.getByRole("img", { name: "Amina Worker profile photo" }).querySelector("img"))
                .toHaveAttribute("src", "blob:updated-avatar"));
            expect(await screen.findByRole("status")).toHaveTextContent("Your profile photo has been updated");
        } finally {
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    it("shows upload progress and synchronizes a replaced photo with the shared header", async () => {
        const pending = deferred();
        mocks.getMyProfile.mockResolvedValue({ ...profile, profile_photo_available: true });
        mocks.getMyProfilePhoto.mockResolvedValue(new Blob(["image"], { type: "image/png" }));
        mocks.uploadMyProfilePhoto.mockReturnValueOnce(pending.promise);
        const originalCreateObjectURL = URL.createObjectURL;
        const originalRevokeObjectURL = URL.revokeObjectURL;
        URL.createObjectURL = vi.fn(() => "blob:refreshed-photo");
        URL.revokeObjectURL = vi.fn();

        try {
            const { rerender } = renderProfile({ includeHeader: true });
            await screen.findByRole("heading", { name: "Amina Worker" });
            const image = new File(["image"], "profile.png", { type: "image/png" });
            fireEvent.change(screen.getByLabelText("Choose profile photo"), { target: { files: [image] } });

            expect(await screen.findByRole("status")).toHaveTextContent("Uploading photo");
            expect(screen.getByRole("button", { name: "Change profile photo" })).toBeDisabled();
            pending.resolve({ ...profile, profile_photo_available: true, updated_at: "2026-10-27T00:00:00.000Z" });

            await waitFor(() => expect(mocks.syncProfile).toHaveBeenCalledWith(
                expect.objectContaining({ profile_photo_available: true }),
                expect.objectContaining({ userId: "user-1" }),
                { photoUpdated: true }
            ));
            rerender(
                <MemoryRouter>
                    <Header />
                    <ProfileCard />
                </MemoryRouter>
            );
            await waitFor(() => expect(screen.getByRole("link", { name: "Open your profile" }).querySelector("img"))
                .toHaveAttribute("src", "blob:refreshed-photo"));
        } finally {
            URL.createObjectURL = originalCreateObjectURL;
            URL.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    it("preserves the current avatar and reports a failed photo upload", async () => {
        mocks.uploadMyProfilePhoto.mockRejectedValueOnce({ message: "Photo upload failed" });
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        const image = new File(["image"], "profile.png", { type: "image/png" });
        fireEvent.change(screen.getByLabelText("Choose profile photo"), { target: { files: [image] } });

        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to upload your profile photo");
        expect(screen.getByRole("img", { name: "Amina Worker profile photo" })).toHaveTextContent("AW");
    });

    it("rejects images outside the server's allowed formats and size", async () => {
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.change(screen.getByLabelText("Choose profile photo"), {
            target: { files: [new File(["bad"], "profile.gif", { type: "image/gif" })] },
        });
        expect(await screen.findByRole("alert")).toHaveTextContent("Choose a JPEG, PNG, or WebP image");
        expect(mocks.uploadMyProfilePhoto).not.toHaveBeenCalled();
    });

    it("rejects profile photos larger than the server's 5 MB limit", async () => {
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        const oversizedImage = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "profile.png", { type: "image/png" });
        fireEvent.change(screen.getByLabelText("Choose profile photo"), { target: { files: [oversizedImage] } });

        expect(await screen.findByRole("alert")).toHaveTextContent("Profile photos must be 5 MB or smaller");
        expect(mocks.uploadMyProfilePhoto).not.toHaveBeenCalled();
    });

    it("enables full-name inline editing and cancel discards changes", async () => {
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.click(screen.getByRole("button", { name: "Edit full name" }));
        const input = screen.getByLabelText("Full name");
        expect(input).toHaveValue("Amina Worker");
        fireEvent.change(input, { target: { value: "Unsaved name" } });
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(screen.queryByLabelText("Full name")).not.toBeInTheDocument();
        expect(screen.getByText("Amina Worker", { selector: ".profile-field-value" })).toBeInTheDocument();
        expect(mocks.updateMyProfile).not.toHaveBeenCalled();
    });

    it("enables email inline editing and validates email input semantics", async () => {
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.click(screen.getByRole("button", { name: "Edit email address" }));
        expect(screen.getByLabelText("Email address")).toHaveAttribute("type", "email");
        expect(screen.getByLabelText("Email address")).toHaveValue("amina@example.com");
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "invalid-email" } });
        expect(screen.getByLabelText("Email address")).toBeInvalid();
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Enter a valid email address");
        expect(mocks.updateMyProfile).not.toHaveBeenCalled();
    });

    it("saves a name update through the profile API and syncs the shared header", async () => {
        const { rerender } = renderProfile({ includeHeader: true });
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.click(screen.getByRole("button", { name: "Edit full name" }));
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Bradley Omondi Juma" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(mocks.updateMyProfile).toHaveBeenCalledWith({
            full_name: "Bradley Omondi Juma",
        }));
        expect(await screen.findByRole("status")).toHaveTextContent("Full name updated");
        rerender(
            <MemoryRouter>
                <Header />
                <ProfileCard />
            </MemoryRouter>
        );
        expect(screen.getByText("Bradley Omondi Juma", { selector: ".app-header-user-name" })).toBeInTheDocument();
        expect(mocks.syncProfile).toHaveBeenCalledWith(
            expect.objectContaining({ full_name: "Bradley Omondi Juma" }),
            expect.objectContaining({ userId: "user-1" })
        );
    });

    it("persists an email update and shows the server's uniqueness message on failure", async () => {
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.click(screen.getByRole("button", { name: "Edit email address" }));
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "new@example.com" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => expect(mocks.updateMyProfile).toHaveBeenCalledWith({
            email: "new@example.com",
        }));
        expect(await screen.findByRole("status")).toHaveTextContent("Email address saved as pending");
        expect(screen.getByText("new@example.com", { selector: ".profile-field-value" })).toBeInTheDocument();

        mocks.updateMyProfile.mockRejectedValueOnce({ message: "That email address is already in use" });
        fireEvent.click(screen.getByRole("button", { name: "Edit email address" }));
        fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "taken@example.com" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("That email address is already in use");
        expect(screen.getByLabelText("Email address")).toHaveValue("taken@example.com");
    });

    it("shows a full-name-specific server validation error and keeps the edit available", async () => {
        mocks.updateMyProfile.mockRejectedValueOnce({
            message: "Full name must be 2 to 100 characters and contain valid name characters",
        });
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.click(screen.getByRole("button", { name: "Edit full name" }));
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina New" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));

        expect(await screen.findByRole("alert")).toHaveTextContent("Full name must be 2 to 100 characters");
        expect(screen.getByLabelText("Full name")).toHaveValue("Amina New");
        expect(mocks.updateMyProfile).toHaveBeenCalledWith({ full_name: "Amina New" });
    });

    it("retains failed name edits for retry and prevents duplicate submissions", async () => {
        const pending = deferred();
        mocks.updateMyProfile.mockReturnValueOnce(pending.promise);
        renderProfile();
        await screen.findByRole("heading", { name: "Amina Worker" });
        fireEvent.click(screen.getByRole("button", { name: "Edit full name" }));
        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Amina Retry" } });
        const saveButton = screen.getByRole("button", { name: "Save" });
        fireEvent.click(saveButton);
        fireEvent.click(saveButton);

        expect(mocks.updateMyProfile).toHaveBeenCalledTimes(1);
        expect(saveButton).toBeDisabled();
        pending.reject({ message: "Unable to save profile" });
        expect(await screen.findByRole("alert")).toHaveTextContent("Unable to save profile");
        expect(screen.getByLabelText("Full name")).toHaveValue("Amina Retry");
        expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

        fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "Bradley Omondi Juma" } });
        fireEvent.click(screen.getByRole("button", { name: "Save" }));
        await waitFor(() => expect(mocks.updateMyProfile).toHaveBeenCalledTimes(2));
        expect(await screen.findByRole("status")).toHaveTextContent("Full name updated");
        expect(screen.getByText("Bradley Omondi Juma", { selector: ".profile-field-value" })).toBeInTheDocument();
    });

    it.each(["WORKER", "ADMIN", "FUND_MANAGER", "REGULATOR"])(
        "uses the shared inline profile experience for the %s role",
        async (role) => {
            mocks.getMyProfile.mockResolvedValueOnce({ ...profile, role });
            renderProfile();
            expect(await screen.findByRole("heading", { name: "Amina Worker" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Change profile photo" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Edit full name" })).toBeInTheDocument();
            expect(screen.getByRole("button", { name: "Edit email address" })).toBeInTheDocument();
            expect(screen.queryByText("Upload photo")).not.toBeInTheDocument();
        }
    );
});
