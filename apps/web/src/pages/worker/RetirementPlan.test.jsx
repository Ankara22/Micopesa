import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import RetirementPlan from "./RetirementPlan";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
    getMyPlan: vi.fn(),
    saveMyPlan: vi.fn(),
}));

vi.mock("../../services/retirementService", () => ({
    getMyPlan: mocks.getMyPlan,
    saveMyPlan: mocks.saveMyPlan,
}));

describe("worker retirement plan localization", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("sw");
        vi.clearAllMocks();
        mocks.getMyPlan.mockResolvedValue({
            plan: { plan_id: "plan-1", target_amount: "500000.00", target_age: 60, plan_status: "ACTIVE" },
            projection: { current_age: 30, assumed_contribution: "250.00" },
        });
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("translates the saved plan and editable assumptions", async () => {
        render(<ToastProvider><RetirementPlan /></ToastProvider>);

        expect(await screen.findByRole("heading", { name: "Mpango wa Kustaafu" })).toBeInTheDocument();
        expect(screen.getByText("Mpango wa sasa")).toBeInTheDocument();
        expect(screen.getByLabelText("Umri wako wa sasa")).toHaveValue(30);
        expect(screen.getByLabelText("Lengo la akiba ya kustaafu (KSh)")).toHaveValue(500000);
        expect(screen.getByRole("button", { name: "Kokotoa Makadirio" })).toBeInTheDocument();
    });
});
