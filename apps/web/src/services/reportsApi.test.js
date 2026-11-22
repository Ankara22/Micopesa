import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import { getReportAnalytics, getReportHistory } from "./reportsApi";

vi.mock("./api", () => ({
    default: { get: vi.fn() },
}));

describe("report data API response validation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("accepts complete report history and analytics responses", async () => {
        api.get
            .mockResolvedValueOnce({
                data: { data: [], pagination: { page: 1, total_pages: 0 } },
            })
            .mockResolvedValueOnce({
                data: {
                    data: {
                        fund_comparison: [],
                        compliance_trends: [],
                        compliance_evidence: [],
                        compliance_activity: [],
                        risk_summary: [],
                    },
                },
            });

        await expect(getReportHistory()).resolves.toEqual({
            records: [],
            pagination: { page: 1, total_pages: 0 },
        });
        await expect(getReportAnalytics()).resolves.toMatchObject({
            fund_comparison: [],
            risk_summary: [],
        });
    });

    it("accepts fund manager analytics with numeric strings and forwards date filters", async () => {
        const managerAnalytics = {
            contribution_trends: [
                {
                    period: "2026-09-30T21:00:00.000Z",
                    status: "PENDING",
                    contribution_count: 1,
                    allocated_amount: "0.00",
                },
                {
                    period: "2026-10-31T21:00:00.000Z",
                    status: "COMPLETED",
                    contribution_count: 3,
                    allocated_amount: "4700.70",
                },
            ],
            fund_summary: { managed_funds: 3, allocated_workers: 4 },
            fund_performance: [
                {
                    fund_id: "fund-1",
                    fund_name: "Example Fund",
                    risk_level: "MEDIUM",
                    expected_return: "7.52",
                    settled_contributions: "2200.70",
                    settled_contribution_count: 3,
                },
            ],
        };
        api.get.mockResolvedValue({ data: { status: "success", data: managerAnalytics } });

        await expect(getReportAnalytics({
            start_date: "2026-09-01",
            end_date: "2026-10-31",
        })).resolves.toEqual(managerAnalytics);
        expect(api.get).toHaveBeenCalledWith("/api/reports/analytics", {
            params: { start_date: "2026-09-01", end_date: "2026-10-31" },
        });
    });

    it("accepts empty fund manager aggregates and rejects incomplete manager summaries", async () => {
        api.get
            .mockResolvedValueOnce({
                data: {
                    status: "success",
                    data: {
                        contribution_trends: [],
                        fund_summary: { managed_funds: 0, allocated_workers: 0 },
                        fund_performance: [],
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    status: "success",
                    data: {
                        contribution_trends: [],
                        fund_summary: { managed_funds: "not-a-count", allocated_workers: 0 },
                        fund_performance: [],
                    },
                },
            });

        await expect(getReportAnalytics()).resolves.toMatchObject({
            contribution_trends: [],
            fund_summary: { managed_funds: 0, allocated_workers: 0 },
            fund_performance: [],
        });
        await expect(getReportAnalytics()).rejects.toThrow("The analytics response was incomplete.");
    });

    it("rejects incomplete responses instead of presenting empty reports or charts", async () => {
        api.get
            .mockResolvedValueOnce({ data: { data: undefined } })
            .mockResolvedValueOnce({ data: { data: { fund_comparison: [] } } });

        await expect(getReportHistory())
            .rejects.toThrow("The report history response was incomplete.");
        await expect(getReportAnalytics())
            .rejects.toThrow("The analytics response was incomplete.");
    });
});
