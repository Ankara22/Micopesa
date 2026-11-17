import api from "./api";

function isNonNegativeCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

export async function getRegulatorDashboard() {
    const response = await api.get("/api/regulator/dashboard");
    const data = response.data?.data;
    const requiredCounts = [
        data?.scope?.assigned_fund_count,
        data?.scope?.active_assigned_fund_count,
        data?.fund_overview?.total_fund_count,
        data?.fund_overview?.active_fund_count,
        data?.fund_overview?.inactive_fund_count,
        data?.account_overview?.account_count,
        data?.account_overview?.worker_count,
        data?.account_overview?.active_account_count,
        data?.awaiting_review?.count,
        data?.awaiting_review?.synthetic_demo_count,
        data?.audit_summary?.events_last_24h,
        data?.report_summary?.legacy_history_count,
    ];
    const reportSummaryCounts = [
        "total_count",
        "draft_count",
        "submitted_count",
        "awaiting_review_count",
        "incomplete_submission_count",
        "approved_count",
        "returned_count",
        "rejected_count",
    ].flatMap((key) => [
        data?.report_summary?.workflow?.[key],
        data?.report_summary?.synthetic_demo?.[key],
    ]);
    if (
        !data ||
        typeof data !== "object" ||
        typeof data.scope?.has_active_fund_scope !== "boolean" ||
        requiredCounts.some((count) => !isNonNegativeCount(count)) ||
        reportSummaryCounts.some((count) => !isNonNegativeCount(count)) ||
        data.awaiting_review?.count !== data.report_summary?.workflow?.awaiting_review_count ||
        data.awaiting_review?.synthetic_demo_count !== data.report_summary?.synthetic_demo?.awaiting_review_count ||
        !data.control_checks?.summary ||
        Object.values(data.control_checks.summary).some((count) => !isNonNegativeCount(count)) ||
        !Array.isArray(data.recent_compliance_activity) ||
        !data.audit_summary ||
        !Array.isArray(data.kyc?.status_counts) ||
        data.kyc.status_counts.some((item) => !isNonNegativeCount(item?.count)) ||
        !Array.isArray(data.kyc?.recent_review_history) ||
        !Array.isArray(data.awaiting_review?.recent) ||
        !Array.isArray(data.control_checks?.checks) ||
        data.control_checks.checks.some((check) =>
            !check || typeof check.key !== "string" || typeof check.status !== "string"
        )
    ) {
        throw new Error("The regulator dashboard response was incomplete.");
    }
    return data;
}

export async function getComplianceOverview() {
    const response = await api.get("/api/regulator/compliance");
    return response.data.data;
}

export async function getComplianceReports() {
    const response = await api.get("/api/regulator/reports");
    return response.data.data;
}

export async function getRegulatorKycOversight(filters = {}) {
    const response = await api.get("/api/regulator/kyc-oversight", { params: filters });
    const data = response.data?.data;
    if (
        !data ||
        typeof data.scope?.has_active_fund_scope !== "boolean" ||
        !isNonNegativeCount(data.scope.active_assigned_fund_count) ||
        !Array.isArray(data.kyc_status_counts) ||
        data.kyc_status_counts.some((item) => !isNonNegativeCount(item?.count)) ||
        !Array.isArray(data.review_history) ||
        !data.pagination ||
        !isNonNegativeCount(data.pagination.total_count) ||
        !isNonNegativeCount(data.pagination.total_pages)
    ) {
        throw new Error("The KYC oversight response was incomplete.");
    }
    return data;
}

export async function getRegulatorInternalControlChecks() {
    const response = await api.get("/api/regulator/internal-control-checks");
    const data = response.data?.data;
    if (
        !data ||
        !Array.isArray(data.checks) ||
        !data.formal_parameters ||
        !data.summary ||
        Object.values(data.summary).some((count) => !isNonNegativeCount(count))
    ) {
        throw new Error("The internal control-check response was incomplete.");
    }
    return data;
}
