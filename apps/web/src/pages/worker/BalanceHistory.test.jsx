import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BalanceHistory from "./BalanceHistory";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
    getMyBalance: vi.fn(),
    getMyContributions: vi.fn(),
}));

vi.mock("../../services/accountService", () => ({
    getMyBalance: mocks.getMyBalance,
    getMyContributions: mocks.getMyContributions,
}));

describe("worker balance history localization", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("sw");
        vi.clearAllMocks();
        mocks.getMyBalance.mockResolvedValue({ current_balance: "1500.00" });
        mocks.getMyContributions.mockResolvedValue([]);
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("translates balance history and empty state labels", async () => {
        render(<BalanceHistory />);

        expect(await screen.findByRole("heading", { name: "Salio na Historia ya Miamala" })).toBeInTheDocument();
        expect(screen.getByText("Miamala yote")).toBeInTheDocument();
        expect(screen.getByText("Hakuna miamala iliyopatikana.")).toBeInTheDocument();
    });
});
