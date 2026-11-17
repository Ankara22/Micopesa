import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import RegulatoryParameters from "./RegulatoryParameters";

const mocks = vi.hoisted(() => ({
    getRegulatorInternalControlChecks: vi.fn(),
}));

vi.mock("../../services/regulatorApi", () => ({
    getRegulatorInternalControlChecks: mocks.getRegulatorInternalControlChecks,
}));

describe("Regulator parameter and internal control checks", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mocks.getRegulatorInternalControlChecks.mockResolvedValue({
            evaluated_at: "2026-03-01T10:00:00Z",
            formal_parameters: {
                status: "NOT_CONFIGURED",
                source: "Application regulatory configuration",
            },
            checks: [{
                key: "ledger_readiness",
                name: "Pension ledger readiness",
                description: "Reads the existing ledger singleton status without changing it.",
                observed_value: "ACTIVE",
                expected_rule: "The pension ledger singleton must be ACTIVE for ledger-enforced payment settlement.",
                status: "PASS",
                source: "pension_ledger singleton",
                evaluated_at: "2026-03-01T10:00:00Z",
            }],
        });
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("separates unavailable statutory parameters from read-only application checks", async () => {
        render(<RegulatoryParameters />);

        expect(await screen.findByRole("heading", {
            name: "Regulatory Parameter Checks",
        })).toBeInTheDocument();
        expect(screen.getByText("No authoritative RBA limits or parameter set is configured in the application. No statutory threshold is being inferred."))
            .toBeInTheDocument();
        expect(screen.getByRole("heading", {
            name: "Internal System Control Checks — Not Official RBA Regulatory Thresholds",
        })).toBeInTheDocument();
        expect(screen.getByRole("table")).toHaveTextContent("Pension ledger readiness");
        expect(screen.getByRole("table")).toHaveTextContent("ACTIVE");
    });

    it("does not infer unconfigured controls while the request is loading or has failed", async () => {
        mocks.getRegulatorInternalControlChecks.mockImplementation(() => new Promise(() => {}));
        const { unmount } = render(<RegulatoryParameters />);

        expect(screen.getByRole("status", { name: "Loading application control checks" }))
            .toBeInTheDocument();
        expect(screen.queryByText("Application regulatory configuration")).not.toBeInTheDocument();
        unmount();

        mocks.getRegulatorInternalControlChecks.mockRejectedValue(new Error("Control check request failed."));
        render(<RegulatoryParameters />);
        expect(await screen.findByRole("alert")).toHaveTextContent("Control check request failed.");
        expect(screen.queryByText("Application regulatory configuration")).not.toBeInTheDocument();
    });
});
