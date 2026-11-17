import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import {
    getRegulatorDashboard,
    getRegulatorInternalControlChecks,
    getRegulatorKycOversight,
} from "./regulatorApi";

vi.mock("./api", () => ({
    default: { get: vi.fn() },
}));

describe("regulator data API response validation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("accepts a complete scoped dashboard response", async () => {
        api.get.mockResolvedValue({
            data: {
                data: {
                    scope: { assigned_fund_count: 1, active_assigned_fund_count: 1, has_active_fund_scope: true },
                    fund_overview: { total_fund_count: 1, active_fund_count: 1, inactive_fund_count: 0 },
                    account_overview: { account_count: 1, active_account_count: 1, worker_count: 1 },
                    report_summary: {
                        workflow: {
                            total_count: 1,
                            draft_count: 0,
                            submitted_count: 1,
                            awaiting_review_count: 1,
                            incomplete_submission_count: 0,
                            approved_count: 0,
                            returned_count: 0,
                            rejected_count: 0,
                        },
                        synthetic_demo: {
                            total_count: 0,
                            draft_count: 0,
                            submitted_count: 0,
                            awaiting_review_count: 0,
                            incomplete_submission_count: 0,
                            approved_count: 0,
                            returned_count: 0,
                            rejected_count: 0,
                        },
                        legacy_history_count: 0,
                    },
                    awaiting_review: { count: 1, synthetic_demo_count: 0, recent: [] },
                    recent_compliance_activity: [],
                    audit_summary: { events_last_24h: 1, last_event_at: null },
                    kyc: { status_counts: [{ kyc_status: "VERIFIED", count: 1 }], recent_review_history: [] },
                    control_checks: {
                        summary: {
                            evaluated_count: 1,
                            passed_count: 1,
                            failed_count: 0,
                            attention_required_count: 0,
                            unevaluated_count: 0,
                            not_configured_count: 0,
                        },
                        checks: [{ key: "ledger", status: "PASS" }],
                    },
                },
            },
        });

        await expect(getRegulatorDashboard()).resolves.toMatchObject({
            scope: { has_active_fund_scope: true },
            report_summary: { workflow: { awaiting_review_count: 1 } },
        });
    });

    it("rejects missing dashboard counts rather than coercing them to zero", async () => {
        api.get.mockResolvedValue({
            data: {
                data: {
                    scope: { assigned_fund_count: null, active_assigned_fund_count: 0, has_active_fund_scope: false },
                    fund_overview: { total_fund_count: 0, active_fund_count: 0, inactive_fund_count: 0 },
                    account_overview: { account_count: 0, active_account_count: 0, worker_count: 0 },
                    report_summary: {},
                    awaiting_review: { count: 0, synthetic_demo_count: 0, recent: [] },
                    recent_compliance_activity: [],
                    audit_summary: { events_last_24h: 0, last_event_at: null },
                    kyc: { status_counts: [], recent_review_history: [] },
                    control_checks: { summary: {}, checks: [] },
                },
            },
        });

        await expect(getRegulatorDashboard())
            .rejects.toThrow("The regulator dashboard response was incomplete.");
    });

    it("rejects incomplete KYC and control-check summaries", async () => {
        api.get
            .mockResolvedValueOnce({
                data: {
                    data: {
                        scope: { has_active_fund_scope: true, active_assigned_fund_count: 1 },
                        kyc_status_counts: [{ kyc_status: "VERIFIED", count: null }],
                        review_history: [],
                        pagination: { total_count: 0, total_pages: 0 },
                    },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    data: {
                        checks: [],
                        formal_parameters: { status: "NOT_CONFIGURED" },
                        summary: { passed_count: null },
                    },
                },
            });

        await expect(getRegulatorKycOversight())
            .rejects.toThrow("The KYC oversight response was incomplete.");
        await expect(getRegulatorInternalControlChecks())
            .rejects.toThrow("The internal control-check response was incomplete.");
    });
});
