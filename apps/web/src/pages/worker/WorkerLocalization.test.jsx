import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "../../components/ui/ToastContext";
import LanguageSwitcher from "../../components/LanguageSwitcher";
import Contributions from "./Contributions";
import i18n from "../../i18n";

const mocks = vi.hoisted(() => ({
    getMyBalance: vi.fn(),
    getMyContributions: vi.fn(),
    getMyAllocations: vi.fn(),
    listAvailableFunds: vi.fn(),
    initiateMyContribution: vi.fn(),
}));

vi.mock("../../services/accountService", () => ({
    getMyBalance: mocks.getMyBalance,
    getMyContributions: mocks.getMyContributions,
    initiateMyContribution: mocks.initiateMyContribution,
}));
vi.mock("../../services/fundService", () => ({
    getMyAllocations: mocks.getMyAllocations,
    listAvailableFunds: mocks.listAvailableFunds,
}));

function CurrentPath() {
    const { pathname } = useLocation();
    return <output data-testid="current-path">{pathname}</output>;
}

function renderContributionsRoute() {
    return render(
        <ToastProvider>
            <MemoryRouter initialEntries={["/worker/contributions"]}>
                <LanguageSwitcher />
                <CurrentPath />
                <Routes>
                    <Route path="/worker/contributions" element={<Contributions />} />
                </Routes>
            </MemoryRouter>
        </ToastProvider>
    );
}

describe("worker language switching", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("en");
        vi.clearAllMocks();
        mocks.getMyBalance.mockResolvedValue({ current_balance: "1200.00" });
        mocks.getMyContributions.mockResolvedValue([]);
        mocks.getMyAllocations.mockResolvedValue([{
            fund_id: "fund-1",
            fund_name: "Balanced Fund",
            allocation_percentage: "100.00",
        }]);
        mocks.listAvailableFunds.mockResolvedValue([{
            fund_id: "fund-1",
            fund_name: "Balanced Fund",
        }]);
    });

    afterEach(() => {
        cleanup();
        i18n.changeLanguage("en");
    });

    it("changes language immediately without losing the route, modal, or form input", async () => {
        renderContributionsRoute();
        expect(await screen.findByRole("heading", { name: "Contributions / Deposit" })).toBeInTheDocument();
        expect(screen.getByTestId("current-path")).toHaveTextContent("/worker/contributions");
        fireEvent.click(screen.getByRole("button", { name: "Record contribution" }));
        fireEvent.change(screen.getByLabelText("Amount (KES)"), { target: { value: "72.50" } });
        fireEvent.click(await screen.findByLabelText(/Balanced Fund/));

        fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "sw" } });

        expect(await screen.findByRole("heading", { name: "Michango / Kuweka Pesa" })).toBeInTheDocument();
        expect(screen.getByTestId("current-path")).toHaveTextContent("/worker/contributions");
        expect(screen.getByRole("dialog", { name: "Rekodi mchango unaosubiri" })).toBeInTheDocument();
        expect(screen.getByLabelText("Kiasi (KES)")).toHaveValue(72.5);
        expect(screen.getByLabelText(/Balanced Fund/)).toBeChecked();
        expect(screen.getByRole("button", { name: "Weka mchango unaosubiri" })).toBeInTheDocument();
        await waitFor(() => expect(window.localStorage.getItem("micopesa.language")).toBe("sw"));
    });

    it("labels simulator references as synthetic and never infers provider from the reference", async () => {
        mocks.getMyContributions.mockResolvedValue([{
            contribution_id: "contribution-1",
            created_at: "2026-10-12T10:00:00.000Z",
            amount: "25.00",
            channel: "MPESA",
            contribution_status: "COMPLETED",
            transaction_status: "COMPLETED",
            payment_provider: "SIMULATED",
            checkout_request_id: "SIM0123456789ABCDEF012345",
            mpesa_result_description: "SIMULATED: no real money was transferred.",
            fund_allocations: [],
        }, {
            contribution_id: "contribution-2",
            created_at: "2026-10-11T10:00:00.000Z",
            amount: "10.00",
            channel: "MPESA",
            contribution_status: "PENDING",
            transaction_status: "PENDING",
            payment_provider: "UNRESOLVED",
            checkout_request_id: "SIM0123456789ABCDEF012346",
            mpesa_result_description: "",
            fund_allocations: [],
        }]);

        renderContributionsRoute();

        expect(await screen.findByText(/SIMULATED — no real money transferred/)).toBeInTheDocument();
        expect(screen.getByText(/Synthetic reference: SIM0123456789ABCDEF012345/)).toBeInTheDocument();
        expect(screen.queryByText(/Synthetic reference: SIM0123456789ABCDEF012346/)).not.toBeInTheDocument();
    });
});
