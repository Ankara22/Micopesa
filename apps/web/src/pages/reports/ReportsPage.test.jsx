import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui/ToastContext";
import i18n from "../../i18n";
import ReportsPage from "./ReportsPage";

const mocks = vi.hoisted(() => ({
    downloadReport: vi.fn(),
    generateReport: vi.fn(),
    getReportCatalog: vi.fn(),
    getReportFunds: vi.fn(),
    getReportHistory: vi.fn(),
}));

vi.mock("../../services/reportsApi", () => ({
    downloadReport: mocks.downloadReport,
    generateReport: mocks.generateReport,
    getReportCatalog: mocks.getReportCatalog,
    getReportFunds: mocks.getReportFunds,
    getReportHistory: mocks.getReportHistory,
}));

vi.mock("../../context/AuthContext", () => ({
    useAuth: () => ({ user: { role: "REGULATOR" } }),
}));

describe("role-scoped reports UI", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        i18n.changeLanguage("en");
        vi.stubGlobal("URL", {
            createObjectURL: vi.fn(() => "blob:report"),
            revokeObjectURL: vi.fn(),
        });
        mocks.getReportCatalog.mockResolvedValue(["settled-contributions"]);
        mocks.getReportFunds.mockResolvedValue([{ fund_id: "fund-1", fund_name: "Example Fund" }]);
        mocks.getReportHistory.mockResolvedValue({
            records: [],
            pagination: { page: 1, total_pages: 0 },
        });
        mocks.generateReport.mockResolvedValue({
            data: new Blob(["report"]),
            headers: { "content-type": "text/csv" },
        });
        mocks.downloadReport.mockResolvedValue({
            data: new Blob(["report"]),
            headers: { "content-type": "text/csv" },
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        i18n.changeLanguage("en");
    });

    it("generates a selected format with validated user filters and refreshes history", async () => {
        render(<ToastProvider><ReportsPage /></ToastProvider>);

        await screen.findByRole("option", { name: "Settled contributions" });
        await screen.findByRole("option", { name: "Example Fund" });
        fireEvent.change(await screen.findByLabelText("Report"), {
            target: { value: "settled-contributions" },
        });
        fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "XLSX" } });
        fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-01" } });
        fireEvent.change(screen.getByLabelText("Fund"), { target: { value: "fund-1" } });
        fireEvent.click(screen.getByRole("button", { name: "Generate and download" }));

        await waitFor(() => expect(mocks.generateReport).toHaveBeenCalledWith({
            report_key: "settled-contributions",
            format: "XLSX",
            filters: { start_date: "2026-11-01", fund_id: "fund-1" },
        }));
        await waitFor(() => expect(mocks.getReportHistory).toHaveBeenCalledTimes(2));
        expect(URL.createObjectURL).toHaveBeenCalled();
    });

    it("shows a notice when the generated report contains more than 5,000 matching rows", async () => {
        mocks.generateReport.mockResolvedValue({
            data: new Blob(["report"]),
            headers: {
                "content-type": "text/csv",
                "x-report-truncated": "true",
                "x-report-total-count": "5001",
            },
        });
        render(<ToastProvider><ReportsPage /></ToastProvider>);

        await screen.findByRole("option", { name: "Settled contributions" });
        fireEvent.change(screen.getByLabelText("Report"), {
            target: { value: "settled-contributions" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Generate and download" }));

        expect(await screen.findByText(
            "At least 5001 matching records were found. Only the first 5,000 are included in this export."
        )).toBeInTheDocument();
    });

    it("downloads a history item through the permission-checking endpoint", async () => {
        mocks.getReportHistory.mockResolvedValue({
            records: [{
                report_id: "report-1",
                report_key: "settled-contributions",
                export_format: "CSV",
                generated_at: "2026-11-04T09:00:00Z",
                generation_status: "SUCCEEDED",
                result_count: 1,
                download_count: 0,
                generated_by_name: "Manager One",
            }],
            pagination: { page: 1, total_pages: 1 },
        });
        render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);

        fireEvent.click(await screen.findByRole("button", { name: "Download" }));
        await waitFor(() => expect(mocks.downloadReport).toHaveBeenCalledWith("report-1"));
    });

    it("shows truncation metadata after downloading a history item", async () => {
        mocks.getReportHistory.mockResolvedValue({
            records: [{
                report_id: "report-1",
                report_key: "settled-contributions",
                export_format: "CSV",
                generated_at: "2026-11-04T09:00:00Z",
                generation_status: "SUCCEEDED",
                result_count: 5000,
                download_count: 0,
                generated_by_name: "Manager One",
            }],
            pagination: { page: 1, total_pages: 1 },
        });
        mocks.downloadReport.mockResolvedValue({
            data: new Blob(["report"]),
            headers: {
                "content-type": "text/csv",
                "x-report-truncated": "true",
                "x-report-total-count": "5001",
            },
        });
        render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);

        fireEvent.click(await screen.findByRole("button", { name: "Download" }));
        expect(await screen.findByText(
            "At least 5001 matching records were found. Only the first 5,000 are included in this export."
        )).toBeInTheDocument();
    });

    it("loads the requested report-history page", async () => {
        mocks.getReportHistory
            .mockResolvedValueOnce({
                records: [],
                pagination: { page: 1, total_pages: 2 },
            })
            .mockResolvedValueOnce({
                records: [],
                pagination: { page: 2, total_pages: 2 },
            });
        render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);

        expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Next" }));
        await waitFor(() => {
            expect(mocks.getReportHistory).toHaveBeenLastCalledWith({
                page: 2,
                page_size: 50,
            });
        });
        expect(await screen.findByText("Page 2 of 2")).toBeInTheDocument();
    });

    it("shows a real empty state and does not coerce malformed history into an empty list", async () => {
        const { unmount: unmountEmptyState } = render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);

        expect(await screen.findByText("No reports have been generated.")).toBeInTheDocument();
        unmountEmptyState();

        mocks.getReportHistory.mockResolvedValueOnce({
            records: null,
            pagination: { page: 1, total_pages: 0 },
        });
        const { unmount } = render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);
        expect(await screen.findByRole("alert"))
            .toHaveTextContent("The service returned information in an unexpected format.");
        expect(screen.queryByText("No reports have been generated.")).not.toBeInTheDocument();
        unmount();
    });

    it("retries a failed report-history request", async () => {
        mocks.getReportHistory
            .mockRejectedValueOnce(new Error("Report history is unavailable."))
            .mockResolvedValueOnce({
                records: [],
                pagination: { page: 1, total_pages: 0 },
            });
        render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);

        expect(await screen.findByRole("alert")).toHaveTextContent("Report history is unavailable.");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(await screen.findByText("No reports have been generated.")).toBeInTheDocument();
        expect(mocks.getReportHistory).toHaveBeenCalledTimes(2);
    });
});
