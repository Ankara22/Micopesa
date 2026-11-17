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
