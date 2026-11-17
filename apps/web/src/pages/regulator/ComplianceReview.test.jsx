import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import ComplianceReview from "./ComplianceReview";

const mocks = vi.hoisted(() => ({
    listFunds: vi.fn(),
    getRegulatorReport: vi.fn(),
    listRegulatorReports: vi.fn(),
    reviewRegulatorReport: vi.fn(),
}));

vi.mock("../../services/fundService", () => ({
    listFunds: mocks.listFunds,
}));
vi.mock("../../services/complianceReportService", () => ({
    getRegulatorReport: mocks.getRegulatorReport,
    listRegulatorReports: mocks.listRegulatorReports,
    reviewRegulatorReport: mocks.reviewRegulatorReport,
}));

describe("regulator compliance review loading failures", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mocks.listFunds.mockResolvedValue([]);
        mocks.listRegulatorReports.mockRejectedValue(new Error("Report register request failed."));
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("does not display zero awaiting reports when the report request failed", async () => {
        render(
            <MemoryRouter>
                <ToastProvider>
                    <ComplianceReview />
                </ToastProvider>
            </MemoryRouter>
        );

        expect(await screen.findAllByRole("alert")).toHaveLength(2);
        expect(screen.queryByText("0 awaiting review")).not.toBeInTheDocument();
        expect(screen.getAllByText("Report register request failed.")).toHaveLength(2);
    });
});
