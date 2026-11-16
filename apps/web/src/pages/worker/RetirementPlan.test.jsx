import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../../components/ui/ToastContext";
import RetirementPlan from "./RetirementPlan";
import { getProfileAge } from "../../components/Retirement/retirementAge";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
    getMyPlan: vi.fn(),
    getMyProfile: vi.fn(),
    profileApiGet: vi.fn(),
    saveMyPlan: vi.fn(),
}));

vi.mock("../../services/retirementService", () => ({
    getMyPlan: mocks.getMyPlan,
    saveMyPlan: mocks.saveMyPlan,
}));
vi.mock("../../services/api", () => ({
    default: { get: mocks.profileApiGet },
}));

function dateOfBirthForAge(age) {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear() - age, now.getUTCMonth(), now.getUTCDate()))
        .toISOString()
        .slice(0, 10);
}

function renderPage() {
    return render(
        <MemoryRouter>
            <ToastProvider><RetirementPlan /></ToastProvider>
        </MemoryRouter>
    );
}

describe("worker retirement plan localization", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("sw");
        vi.clearAllMocks();
        mocks.getMyProfile.mockResolvedValue({ date_of_birth: dateOfBirthForAge(30) });
        mocks.profileApiGet.mockImplementation(async () => ({
            data: { data: { user: await mocks.getMyProfile() } },
        }));
        mocks.getMyPlan.mockResolvedValue({
            plan: { plan_id: "plan-1", target_amount: "500000.00", target_age: 60, plan_status: "ACTIVE" },
            projection: { current_age: 30, assumed_contribution: "250.00" },
        });
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("translates the saved plan and shows age calculated from the profile DOB", async () => {
        renderPage();

        expect(await screen.findByRole("heading", { name: "Mpango wa Kustaafu" })).toBeInTheDocument();
        expect(screen.getByText("Mpango wa sasa")).toBeInTheDocument();
        expect(mocks.profileApiGet).toHaveBeenCalledWith("/api/profile/me");
        expect(screen.getByLabelText("Umri wako wa sasa")).toHaveValue(getProfileAge(dateOfBirthForAge(30)));
        expect(screen.getByLabelText("Umri wako wa sasa")).toHaveAttribute("readonly");
        expect(screen.getByLabelText("Lengo la akiba ya kustaafu (KSh)")).toHaveValue(500000);
        expect(screen.getByRole("button", { name: "Kokotoa Makadirio" })).toBeInTheDocument();
    });

    it("prompts the worker to create a plan when none exists", async () => {
        mocks.getMyPlan.mockResolvedValue({ plan: null, projection: null });
        renderPage();

        expect(await screen.findByRole("heading", { name: "Kokotoa makadirio ya kustaafu" }))
            .toBeInTheDocument();
        expect(screen.getByText(/Anza kupanga maisha yako ya baadaye/)).toBeInTheDocument();
        expect(screen.getByLabelText("Umri wako wa sasa")).toHaveAttribute("readonly");
        expect(screen.queryByRole("button", { name: "Jaribu tena" })).not.toBeInTheDocument();
    });

    it("requires a missing profile date of birth instead of using the saved projection age", async () => {
        mocks.getMyProfile.mockResolvedValue({ date_of_birth: null });
        renderPage();

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "Weka tarehe sahihi ya kuzaliwa kwenye wasifu wako"
        );
        expect(screen.getByRole("link", { name: "Nenda kwenye wasifu wako" }))
            .toHaveAttribute("href", "/worker/profile");
        expect(screen.queryByRole("button", { name: "Kokotoa Makadirio" })).not.toBeInTheDocument();
    });

    it("populates the age after an asynchronously loaded profile arrives", async () => {
        let resolveProfile;
        mocks.getMyProfile.mockReturnValue(new Promise((resolve) => {
            resolveProfile = resolve;
        }));
        renderPage();

        expect(screen.queryByLabelText("Umri wako wa sasa")).not.toBeInTheDocument();
        resolveProfile({ date_of_birth: dateOfBirthForAge(36) });

        expect(await screen.findByLabelText("Umri wako wa sasa"))
            .toHaveValue(getProfileAge(dateOfBirthForAge(36)));
    });
});
