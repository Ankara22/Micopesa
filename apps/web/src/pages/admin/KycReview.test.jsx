import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import "../../i18n";
import KycReview from "./KycReview";

const mocks = vi.hoisted(() => ({
    listPendingKycApplications: vi.fn(),
    reviewKycApplication: vi.fn(),
    refetch: vi.fn(),
    submissions: [],
}));

vi.mock("../../services/adminService", () => ({
    listPendingKycApplications: mocks.listPendingKycApplications,
    reviewKycApplication: mocks.reviewKycApplication,
}));
vi.mock("../../hooks/useApi", () => ({
    default: () => ({
        data: mocks.submissions,
        loading: false,
        refreshing: false,
        error: null,
        refetch: mocks.refetch,
    }),
}));

function renderPage() {
    return render(<ToastProvider><KycReview /></ToastProvider>);
}

describe("Admin KYC review", () => {
    afterEach(cleanup);

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.submissions = [{
            kyc_id: "synthetic-kyc-1",
            full_name: "Synthetic Worker",
            email: "worker@example.test",
            phone: "+254700000001",
            date_of_birth: "1990-04-15",
            masked_national_id: "****1234",
            kyc_status: "PENDING",
            duplicate_submission: true,
        }];
        mocks.listPendingKycApplications.mockResolvedValue(mocks.submissions);
        mocks.reviewKycApplication.mockResolvedValue({ kyc_status: "VERIFIED" });
        mocks.refetch.mockResolvedValue([]);
    });

    it("shows pending review context, duplicate flag, masked ID, and no government-verification claim", () => {
        renderPage();

        expect(screen.getByRole("heading", { name: "KYC review" })).toBeInTheDocument();
        expect(screen.getByText("Synthetic Worker")).toBeInTheDocument();
        expect(screen.getByText("1990-04-15")).toBeInTheDocument();
        expect(screen.getByText("****1234")).toBeInTheDocument();
        expect(screen.getByText("Possible duplicate")).toBeInTheDocument();
        expect(screen.getByText(/not government identity verification/)).toBeInTheDocument();
        expect(screen.queryByText("12345678")).not.toBeInTheDocument();
    });

    it("approves a pending application and refreshes the list", async () => {
        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Approve" }));

        await waitFor(() => {
            expect(mocks.reviewKycApplication).toHaveBeenCalledWith("synthetic-kyc-1", "VERIFIED");
            expect(mocks.refetch).toHaveBeenCalledOnce();
        });
        expect(await screen.findByRole("status")).toHaveTextContent("KYC application approved.");
    });

    it("rejects a pending application and refreshes the list", async () => {
        mocks.reviewKycApplication.mockResolvedValueOnce({ kyc_status: "REJECTED" });
        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Reject" }));

        await waitFor(() => {
            expect(mocks.reviewKycApplication).toHaveBeenCalledWith("synthetic-kyc-1", "REJECTED");
            expect(mocks.refetch).toHaveBeenCalledOnce();
        });
        expect(await screen.findByRole("status")).toHaveTextContent("KYC application rejected.");
    });

    it("explains when approval is blocked by an already verified National ID", async () => {
        mocks.reviewKycApplication.mockRejectedValueOnce({
            data: { code: "KYC_NATIONAL_ID_ALREADY_VERIFIED" },
            message: "Conflict",
        });
        renderPage();
        fireEvent.click(screen.getByRole("button", { name: "Approve" }));

        expect(await screen.findByRole("alert")).toHaveTextContent(
            "This National ID already has a verified record. The application was not approved."
        );
        expect(mocks.refetch).not.toHaveBeenCalled();
    });
});
