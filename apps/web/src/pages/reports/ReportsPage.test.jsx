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
        mocks.getReportHistory.mockResolvedValue([]);
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
        mocks.getReportHistory.mockResolvedValue([{
            report_id: "report-1",
            report_key: "settled-contributions",
            export_format: "CSV",
            generated_at: "2026-11-04T09:00:00Z",
            result_count: 1,
            download_count: 0,
            generated_by_name: "Manager One",
        }]);
        render(<ToastProvider><ReportsPage historyOnly /></ToastProvider>);

        fireEvent.click(await screen.findByRole("button", { name: "Download" }));
        await waitFor(() => expect(mocks.downloadReport).toHaveBeenCalledWith("report-1"));
    });

    it("shows truncation metadata after downloading a history item", async () => {
        mocks.getReportHistory.mockResolvedValue([{
            report_id: "report-1",
            report_key: "settled-contributions",
            export_format: "CSV",
            generated_at: "2026-11-04T09:00:00Z",
            result_count: 5000,
            download_count: 0,
            generated_by_name: "Manager One",
        }]);
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
});
