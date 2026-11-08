const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const pool = require("../src/db/database");
const workflow = require("../src/controllers/complianceReportController");
const regulator = require("../src/controllers/regulatorController");
const complianceRoutes = require("../src/routes/complianceReportRoutes");
const regulatorRoutes = require("../src/routes/regulatorRoutes");
const notificationRoutes = require("../src/routes/workerNotificationRoutes");
const { generateToken } = require("../src/utils/token");

process.env.JWT_SECRET ||= "micopesa-compliance-workflow-isolated-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const fixture = {
    managers: new Set(["manager-1", "manager-2"]),
    regulators: new Set(["regulator-1", "regulator-2"]),
    identities: new Map([
        ["manager-1", { full_name: "Manager One", role: "FUND_MANAGER", account_status: "ACTIVE" }],
        ["manager-2", { full_name: "Manager Two", role: "FUND_MANAGER", account_status: "ACTIVE" }],
        ["regulator-1", { full_name: "Regulator One", role: "REGULATOR", account_status: "ACTIVE" }],
        ["regulator-2", { full_name: "Regulator Two", role: "REGULATOR", account_status: "ACTIVE" }],
    ]),
    funds: new Map([
        ["fund-1", { fund_id: "fund-1", managed_by: "manager-1", fund_name: "Worker Growth" }],
        ["fund-2", { fund_id: "fund-2", managed_by: "manager-2", fund_name: "Community Growth" }],
    ]),
    regulatorAssignments: new Map([
        ["regulator-1", new Set(["fund-1"])],
        ["regulator-2", new Set(["fund-2"])],
    ]),
    inactiveRegulatorAssignments: new Map(),
    reports: new Map(),
    submissions: [],
    reviews: [],
    notifications: [],
    audits: [],
    nextReport: 0,
    nextSubmission: 0,
    nextReview: 0,
    lastQuery: null,
    lastValues: [],
    failOn: null,
    lockTails: new Map(),
};

function resetFixture() {
    fixture.funds.set("fund-1", { fund_id: "fund-1", managed_by: "manager-1", fund_name: "Worker Growth" });
    fixture.funds.set("fund-2", { fund_id: "fund-2", managed_by: "manager-2", fund_name: "Community Growth" });
    fixture.regulatorAssignments = new Map([
        ["regulator-1", new Set(["fund-1"])],
        ["regulator-2", new Set(["fund-2"])],
    ]);
    fixture.inactiveRegulatorAssignments = new Map();
    fixture.identities.set("manager-1", { full_name: "Manager One", role: "FUND_MANAGER", account_status: "ACTIVE" });
    fixture.identities.set("manager-2", { full_name: "Manager Two", role: "FUND_MANAGER", account_status: "ACTIVE" });
    fixture.identities.set("regulator-1", { full_name: "Regulator One", role: "REGULATOR", account_status: "ACTIVE" });
    fixture.identities.set("regulator-2", { full_name: "Regulator Two", role: "REGULATOR", account_status: "ACTIVE" });
    fixture.reports.clear();
    fixture.submissions.length = 0;
    fixture.reviews.length = 0;
    fixture.notifications.length = 0;
    fixture.audits.length = 0;
    fixture.nextReport = 0;
    fixture.nextSubmission = 0;
    fixture.nextReview = 0;
    fixture.lastQuery = null;
    fixture.lastValues = [];
    fixture.failOn = null;
    fixture.lockTails.clear();
}

function result(rows = []) {
    return { rows, rowCount: rows.length };
}

async function fakeQuery(query, values = []) {
    const sql = query.replace(/\s+/g, " ").trim();
    fixture.lastQuery = sql;
    fixture.lastValues = values;
    if (fixture.failOn && sql.includes(fixture.failOn)) {
        throw new Error(`Injected failure for ${fixture.failOn}`);
    }
    if (sql.startsWith("SELECT user_id, role, account_status")) {
        const [userId] = values;
        const role = fixture.identities.get(userId)?.role || (fixture.managers.has(userId) ? "FUND_MANAGER"
            : fixture.regulators.has(userId) ? "REGULATOR"
                : userId === "worker-1" ? "WORKER"
                    : userId === "admin-1" ? "ADMIN" : null);
        return result(role ? [{
            user_id: userId,
            role,
            account_status: fixture.identities.get(userId)?.account_status || "ACTIVE",
            auth_version: 0,
            force_password_change: false,
            is_temp_password: false,
        }] : []);
    }
    if (sql.startsWith("SELECT user_id, full_name, role FROM users")) {
        const [userId] = values;
        const identity = fixture.identities.get(userId);
        return result(identity && (!sql.includes("account_status = 'ACTIVE'") || identity.account_status === "ACTIVE")
            ? [{ user_id: userId, ...identity }] : []);
    }
    if (sql.includes("SELECT fund_id FROM funds WHERE fund_id = $1 AND managed_by = $2")) {
        const fund = fixture.funds.get(values[0]);
        return result(fund?.managed_by === values[1] ? [{ fund_id: fund.fund_id }] : []);
    }
    if (sql.startsWith("SELECT managed_by FROM funds WHERE fund_id = $1")) {
        const fund = fixture.funds.get(values[0]);
        return result(fund ? [{ managed_by: fund.managed_by }] : []);
    }
    if (sql.includes("INSERT INTO compliance_reports")) {
        const [managerId, fundId, type, start, end, content] = values;
        const report = {
            report_id: `report-${++fixture.nextReport}`,
            generated_by: managerId,
            fund_id: fundId,
            fund_name: fixture.funds.get(fundId)?.fund_name,
            is_legacy: false,
            report_type: type,
            period_start: start,
            period_end: end,
            report_content: JSON.parse(content),
            rba_status: "DRAFT",
            generated_at: "2026-01-01T00:00:00Z",
        };
        fixture.reports.set(report.report_id, report);
        return result([report]);
    }
    if (sql.includes("FROM compliance_reports cr JOIN funds f") && sql.includes("f.managed_by = $2")) {
        const report = fixture.reports.get(values[0]);
        const fund = report && fixture.funds.get(report.fund_id);
        return result(fund?.managed_by === values[1] ? [{ ...report }] : []);
    }
    if (sql.startsWith("SELECT cr.report_id FROM compliance_reports cr JOIN funds f") && sql.includes("FOR SHARE OF cr, f")) {
        const report = fixture.reports.get(values[0]);
        const fund = report && fixture.funds.get(report.fund_id);
        return result(fund?.managed_by === values[1] ? [{ report_id: report.report_id }] : []);
    }
    if (sql.startsWith("SELECT cr.report_id, cr.fund_id, f.fund_name")) {
        return result([...fixture.reports.values()]
            .filter((report) => fixture.funds.get(report.fund_id)?.managed_by === values[0])
            .map((report) => ({ ...report, fund_name: fixture.funds.get(report.fund_id).fund_name })));
    }
    if (sql.startsWith("SELECT cr.report_id, cr.generated_by, manager.full_name")) {
        assert.match(sql, /\bcr\.is_legacy\b/);
        const report = fixture.reports.get(values[0]);
        if (!report) return result([]);
        const fund = fixture.funds.get(report.fund_id);
        return result([{
            ...report,
            manager_name: report.generated_by ? "Original Manager" : null,
            fund_name: fund?.fund_name || null,
            managed_by: fund?.managed_by || null,
        }]);
    }
    if (sql.startsWith("SELECT submission_id, version, submitted_by")) {
        return result(fixture.submissions
            .filter((submission) => submission.report_id === values[0])
            .sort((left, right) => left.version - right.version));
    }
    if (sql.startsWith("SELECT review.review_id")) {
        return result(fixture.reviews
            .filter((review) => review.report_id === values[0])
            .map((review) => ({
                ...review,
                reviewer_name: review.reviewed_by_name,
                reviewer_role: review.reviewed_by_role,
            })));
    }
    if (sql.startsWith("SELECT report_id FROM compliance_reports") && sql.includes("is_legacy = TRUE")) {
        const report = fixture.reports.get(values[0]);
        const assignedFunds = fixture.regulatorAssignments.get(values[1]) || new Set();
        return result(report && assignedFunds.has(report.fund_id) &&
            (report.is_legacy || report.rba_status !== "DRAFT")
            ? [{ report_id: report.report_id }] : []);
    }
    if (sql.startsWith("UPDATE compliance_reports SET report_type = $1")) {
        const [type, start, end, content, reportId] = values;
        const report = fixture.reports.get(reportId);
        Object.assign(report, { report_type: type, period_start: start, period_end: end, report_content: JSON.parse(content) });
        return result([{ ...report }]);
    }
    if (sql.includes("SELECT COALESCE(MAX(version), 0)::int + 1")) {
        const versions = fixture.submissions
            .filter((submission) => submission.report_id === values[0])
            .map((submission) => submission.version);
        return result([{ version: Math.max(0, ...versions) + 1 }]);
    }
    if (sql.includes("INSERT INTO compliance_report_submissions")) {
        const [reportId, version, userId, userName, userRole, content, reportType, start, end] = values;
        const submission = {
            submission_id: `submission-${++fixture.nextSubmission}`,
            report_id: reportId,
            version,
            submitted_by: userId,
            submitted_by_name: userName,
            submitted_by_role: userRole,
            report_content: JSON.parse(content),
            report_type: reportType,
            period_start: start,
            period_end: end,
            submitted_at: `2026-01-0${version}T00:00:00Z`,
        };
        fixture.submissions.push(submission);
        return result([submission]);
    }
    if (sql.startsWith("UPDATE compliance_reports SET rba_status = 'SUBMITTED'")) {
        const report = fixture.reports.get(values[0]);
        report.rba_status = "SUBMITTED";
        report.submitted_at ||= "2026-01-01T00:00:00Z";
        report.last_submitted_at = `2026-01-0${fixture.submissions.length}T00:00:00Z`;
        return result([report]);
    }
    if (sql.includes("INSERT INTO notifications") && sql.includes("SELECT user_id, 'PUSH'")) {
        for (const userId of fixture.regulators) fixture.notifications.push({ user_id: userId, message: values[0] });
        return result([]);
    }
    if (sql.includes("INSERT INTO notifications") && sql.includes("VALUES ($1, $2, 'PUSH', $3)")) {
        fixture.notifications.push({ user_id: values[0], created_by: values[1], message: values[2] });
        return result([]);
    }
    if (sql.includes("FROM notifications WHERE user_id = $1")) {
        return result(fixture.notifications.filter((notification) => notification.user_id === values[0]));
    }
    if (sql.startsWith("SELECT cr.report_id, cr.generated_by AS manager_id")) {
        const assignedFunds = fixture.regulatorAssignments.get(values[0]) || new Set();
        return result([...fixture.reports.values()]
            .filter((report) => assignedFunds.has(report.fund_id) &&
                (report.is_legacy || report.rba_status !== "DRAFT"))
            .map((report) => ({
                ...report,
                manager_id: report.generated_by,
                manager_name: report.generated_by,
                is_legacy_history: report.is_legacy || !report.fund_id || !report.submitted_at
                    || !report.last_submitted_at
                    || !fixture.submissions.some((submission) => submission.report_id === report.report_id),
            })));
    }
    if (sql.includes("INSERT INTO audit_logs")) {
        fixture.audits.push({
            user_id: values[0],
            action_type: values[1],
            entity_name: values[2],
            entity_id: values[3],
            details: values[4] ? JSON.parse(values[4]) : null,
        });
        return result([]);
    }
    if (sql.startsWith("SELECT fund_id FROM regulator_fund_assignments") && sql.endsWith("FOR SHARE")) {
        const [regulatorId, fundId] = values;
        const assignedFunds = fixture.regulatorAssignments.get(regulatorId) || new Set();
        return result(assignedFunds.has(fundId) ? [{ fund_id: fundId }] : []);
    }
    if (sql.includes("SELECT report_id, generated_by, rba_status, is_legacy") && sql.endsWith("FOR UPDATE")) {
        const report = fixture.reports.get(values[0]);
        const assignedFunds = fixture.regulatorAssignments.get(values[1]) || new Set();
        return result(report && assignedFunds.has(report.fund_id) ? [{
            report_id: report.report_id,
            generated_by: report.generated_by,
            rba_status: report.rba_status,
            is_legacy: report.is_legacy,
            fund_id: report.fund_id,
            submitted_at: report.submitted_at,
            last_submitted_at: report.last_submitted_at,
            has_submission: fixture.submissions.some((submission) => submission.report_id === report.report_id),
        }] : []);
    }
    if (sql.includes("SELECT submission_id, version") && sql.includes("ORDER BY version DESC")) {
        const submission = fixture.submissions
            .filter((item) => item.report_id === values[0])
            .sort((left, right) => right.version - left.version)[0];
        return result(submission ? [{ submission_id: submission.submission_id, version: submission.version }] : []);
    }
    if (sql.includes("INSERT INTO compliance_report_reviews")) {
        const [reportId, submissionId, userId, userName, userRole, decision, reason] = values;
        fixture.reviews.push({
            review_id: `review-${++fixture.nextReview}`,
            report_id: reportId,
            submission_id: submissionId,
            reviewed_by: userId,
            reviewed_by_name: userName,
            reviewed_by_role: userRole,
            decision,
            reason,
            created_at: "2026-02-01T00:00:00Z",
        });
        return result([]);
    }
    if (sql.startsWith("UPDATE compliance_reports SET rba_status = $1")) {
        const report = fixture.reports.get(values[1]);
        report.rba_status = values[0];
        return result([report]);
    }
    assert.fail(`Unexpected mocked compliance query: ${sql}`);
}

function copyState() {
    const clone = (value) => JSON.parse(JSON.stringify(value));
    return {
        reports: new Map([...fixture.reports].map(([key, value]) => [key, clone(value)])),
        submissions: clone(fixture.submissions),
        reviews: clone(fixture.reviews),
        notifications: clone(fixture.notifications),
        audits: clone(fixture.audits),
    };
}

function restoreState(snapshot) {
    fixture.reports = snapshot.reports;
    fixture.submissions.splice(0, fixture.submissions.length, ...snapshot.submissions);
    fixture.reviews.splice(0, fixture.reviews.length, ...snapshot.reviews);
    fixture.notifications.splice(0, fixture.notifications.length, ...snapshot.notifications);
    fixture.audits.splice(0, fixture.audits.length, ...snapshot.audits);
}

function makeMockClient() {
    let snapshot = null;
    let mutated = false;
    const releaseLocks = [];
    return {
        async query(query, values = []) {
            const sql = query.replace(/\s+/g, " ").trim();
            if (sql === "BEGIN" || sql.startsWith("BEGIN ")) {
                snapshot = copyState();
                mutated = false;
                return result([]);
            }
            if (sql === "ROLLBACK") {
                if (snapshot && mutated) restoreState(snapshot);
                snapshot = null;
                mutated = false;
                for (const release of releaseLocks.splice(0)) release();
                return result([]);
            }
            if (sql === "COMMIT") {
                snapshot = null;
                mutated = false;
                for (const release of releaseLocks.splice(0)) release();
                return result([]);
            }
            if (sql.includes("FOR UPDATE") || sql.includes("FOR SHARE")) {
                const lockId = sql.startsWith("SELECT fund_id FROM regulator_fund_assignments")
                    ? `regulator-assignment:${values[0]}:${values[1]}`
                    : values[0];
                const previous = fixture.lockTails.get(lockId) || Promise.resolve();
                let unlock;
                const gate = new Promise((resolve) => { unlock = resolve; });
                const tail = previous.then(() => gate);
                fixture.lockTails.set(lockId, tail);
                await previous;
                releaseLocks.push(() => {
                    unlock();
                    if (fixture.lockTails.get(lockId) === tail) fixture.lockTails.delete(lockId);
                });
            }
            if (/^(INSERT|UPDATE|DELETE)\b/.test(sql)) mutated = true;
            return fakeQuery(query, values);
        },
        release() {
            for (const release of releaseLocks.splice(0)) release();
        },
    };
}

pool.query = fakeQuery;
pool.connect = async () => makeMockClient();
after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
});

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
    };
}

const completeReport = {
    fund_id: "fund-1",
    report_type: "RBA",
    period_start: "2026-01-01",
    period_end: "2026-03-31",
    report_content: {
        executive_summary: "A detailed overview of compliance performance.",
        financial_summary: "Financial reporting and key balances are reconciled.",
        risk_and_governance: "Governance controls and identified risks are reviewed.",
        incidents_and_actions: "No material incidents; actions are documented.",
        supporting_information: "Supporting documentation is summarized in this section.",
    },
};

async function createAndSubmit() {
    const createdResponse = response();
    await workflow.createDraft({ user: { userId: "manager-1" }, body: completeReport }, createdResponse);
    assert.equal(createdResponse.statusCode, 201);
    const reportId = createdResponse.body.data.report.report_id;
    const submittedResponse = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, submittedResponse);
    assert.equal(submittedResponse.statusCode, 200);
    return reportId;
}

function latestSubmissionId(reportId) {
    return fixture.submissions.filter((submission) => submission.report_id === reportId).at(-1)?.submission_id;
}

test("fund manager drafts and submits a complete report, creating immutable history and regulator notifications", async () => {
    resetFixture();
    const created = response();
    await workflow.createDraft({ user: { userId: "manager-1" }, body: { fund_id: "fund-1" } }, created);
    assert.equal(created.statusCode, 201);
    assert.equal(created.body.data.report.rba_status, "DRAFT");
    const reportId = created.body.data.report.report_id;

    const incomplete = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, incomplete);
    assert.equal(incomplete.statusCode, 400);
    assert.equal(fixture.submissions.length, 0);

    const updated = response();
    await workflow.updateDraft({ user: { userId: "manager-1" }, params: { reportId }, body: completeReport }, updated);
    assert.equal(updated.statusCode, 200);
    const submitted = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, submitted);

    assert.equal(submitted.statusCode, 200);
    assert.equal(fixture.reports.get(reportId).rba_status, "SUBMITTED");
    assert.equal(fixture.submissions[0].version, 1);
    assert.equal(fixture.notifications.length, 2);
    assert.ok(fixture.notifications.every((notification) => fixture.regulators.has(notification.user_id)));
    assert.deepEqual(fixture.audits.map((entry) => entry.action_type), ["CREATE", "UPDATE", "SUBMIT"]);
});

test("a manager cannot create a report for another manager's fund", async () => {
    resetFixture();
    const res = response();
    await workflow.createDraft({ user: { userId: "manager-2" }, body: { fund_id: "fund-1" } }, res);
    assert.equal(res.statusCode, 404);
    assert.equal(fixture.reports.size, 0);
    assert.equal(fixture.audits.length, 0);
});

test("a manager cannot submit a report after fund ownership changes", async () => {
    resetFixture();
    const created = response();
    await workflow.createDraft({ user: { userId: "manager-1" }, body: completeReport }, created);
    const reportId = created.body.data.report.report_id;
    fixture.funds.set("fund-1", { ...fixture.funds.get("fund-1"), managed_by: "manager-2" });

    const submitted = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, submitted);
    assert.equal(submitted.statusCode, 404);
    assert.equal(fixture.submissions.length, 0);
    assert.equal(fixture.reports.get(reportId).rba_status, "DRAFT");
});

test("the current fund manager owns report access while submission history keeps the original actor", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const revision = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: {
            submission_id: latestSubmissionId(reportId),
            decision: "REVISION_REQUESTED",
            reason: "Please clarify the reported risk controls.",
        },
    }, revision);
    assert.equal(revision.statusCode, 200);

    const originalRead = response();
    await workflow.getManagerReport({
        user: { userId: "manager-1" }, params: { reportId },
    }, originalRead);
    assert.equal(originalRead.statusCode, 200);
    assert.equal(originalRead.body.data.submissions[0].submitted_by, "manager-1");

    const originalEdit = response();
    await workflow.updateDraft({
        user: { userId: "manager-1" }, params: { reportId }, body: completeReport,
    }, originalEdit);
    assert.equal(originalEdit.statusCode, 200);

    fixture.funds.set("fund-1", { ...fixture.funds.get("fund-1"), managed_by: "manager-2" });
    const formerRead = response();
    await workflow.getManagerReport({
        user: { userId: "manager-1" }, params: { reportId },
    }, formerRead);
    assert.equal(formerRead.statusCode, 404);
    const formerEdit = response();
    await workflow.updateDraft({
        user: { userId: "manager-1" }, params: { reportId }, body: completeReport,
    }, formerEdit);
    assert.equal(formerEdit.statusCode, 404);
    const formerList = response();
    await workflow.listManagerReports({ user: { userId: "manager-1" } }, formerList);
    assert.equal(formerList.body.data.some((row) => row.report_id === reportId), false);

    const currentRead = response();
    await workflow.getManagerReport({
        user: { userId: "manager-2" }, params: { reportId },
    }, currentRead);
    assert.equal(currentRead.statusCode, 200);
    assert.equal(currentRead.body.data.report.generated_by, "manager-1");
    assert.equal(currentRead.body.data.submissions[0].submitted_by, "manager-1");
    const currentEdit = response();
    await workflow.updateDraft({
        user: { userId: "manager-2" }, params: { reportId }, body: completeReport,
    }, currentEdit);
    assert.equal(currentEdit.statusCode, 200);
    const resubmitted = response();
    await workflow.submitReport({ user: { userId: "manager-2" }, params: { reportId } }, resubmitted);
    assert.equal(resubmitted.statusCode, 200);
    assert.deepEqual(fixture.submissions.map((submission) => submission.submitted_by), ["manager-1", "manager-2"]);
    const accepted = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { submission_id: latestSubmissionId(reportId), decision: "ACCEPTED" },
    }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(fixture.notifications.at(-1).user_id, "manager-2");

    const unrelatedDraft = response();
    await workflow.createDraft({
        user: { userId: "manager-2" },
        body: { ...completeReport, fund_id: "fund-2" },
    }, unrelatedDraft);
    const unrelatedRead = response();
    await workflow.getManagerReport({
        user: { userId: "manager-1" },
        params: { reportId: unrelatedDraft.body.data.report.report_id },
    }, unrelatedRead);
    assert.equal(unrelatedRead.statusCode, 404);
});

test("regulators cannot review reports for unassigned or inactive fund assignments", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const report = fixture.reports.get(reportId);
    const submissionId = latestSubmissionId(reportId);
    const existingReviewCount = fixture.reviews.length;
    const existingNotificationCount = fixture.notifications.length;
    const existingAuditCount = fixture.audits.length;

    const unassigned = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-2" },
        params: { reportId },
        body: { submission_id: submissionId, decision: "ACCEPTED" },
    }, unassigned);
    assert.equal(unassigned.statusCode, 404);
    assert.deepEqual(unassigned.body, {
        status: "error",
        message: "Submitted compliance report not found",
    });
    assert.match(fixture.lastQuery, /rfa\.active = TRUE/);

    fixture.inactiveRegulatorAssignments.set("regulator-2", new Set([report.fund_id]));
    const inactiveAssignment = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-2" },
        params: { reportId },
        body: { submission_id: submissionId, decision: "ACCEPTED" },
    }, inactiveAssignment);

    assert.equal(inactiveAssignment.statusCode, 404);
    assert.deepEqual(inactiveAssignment.body, {
        status: "error",
        message: "Submitted compliance report not found",
    });
    assert.match(fixture.lastQuery, /rfa\.active = TRUE/);
    assert.equal(fixture.reviews.length, existingReviewCount);
    assert.equal(fixture.notifications.length, existingNotificationCount);
    assert.equal(fixture.audits.length, existingAuditCount);
    assert.equal(report.rba_status, "SUBMITTED");
});

test("submission and review snapshots keep database-backed names and roles after user changes", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const decision = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { submission_id: latestSubmissionId(reportId), decision: "ACCEPTED" },
    }, decision);
    assert.equal(decision.statusCode, 200);

    fixture.identities.set("manager-1", {
        full_name: "Changed Manager Name",
        role: "ADMIN",
        account_status: "INACTIVE",
    });
    fixture.identities.set("regulator-1", {
        full_name: "Changed Regulator Name",
        role: "FUND_MANAGER",
        account_status: "INACTIVE",
    });

    const detail = response();
    await workflow.getManagerReport({
        user: { userId: "manager-1" },
        params: { reportId },
    }, detail);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.body.data.submissions[0].submitted_by, "manager-1");
    assert.equal(detail.body.data.submissions[0].submitted_by_name, "Manager One");
    assert.equal(detail.body.data.submissions[0].submitted_by_role, "FUND_MANAGER");
    assert.equal(detail.body.data.reviews[0].reviewed_by, "regulator-1");
    assert.equal(detail.body.data.reviews[0].reviewer_name, "Regulator One");
    assert.equal(detail.body.data.reviews[0].reviewer_role, "REGULATOR");
});

test("regulator cannot review a draft or reject without a reason", async () => {
    resetFixture();
    const created = response();
    await workflow.createDraft({ user: { userId: "manager-1" }, body: { fund_id: "fund-1" } }, created);
    const reportId = created.body.data.report.report_id;
    const draftReview = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" }, params: { reportId }, body: { decision: "ACCEPTED" },
    }, draftReview);
    assert.equal(draftReview.statusCode, 404);

    const missingReason = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" }, params: { reportId }, body: { decision: "REJECTED", reason: "   " },
    }, missingReason);
    assert.equal(missingReason.statusCode, 400);
    assert.equal(fixture.reviews.length, 0);

    const missingRevisionReason = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" }, params: { reportId }, body: { decision: "REVISION_REQUESTED" },
    }, missingRevisionReason);
    assert.equal(missingRevisionReason.statusCode, 400);
    assert.equal(fixture.reviews.length, 0);

    const meaninglessReason = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { decision: "REJECTED", reason: "too short" },
    }, meaninglessReason);
    assert.equal(meaninglessReason.statusCode, 400);
});

test("inactive and non-regulator accounts cannot issue regulatory decisions", async () => {
    for (const identity of [
        { full_name: "Regulator One", role: "REGULATOR", account_status: "INACTIVE" },
        { full_name: "Manager One", role: "FUND_MANAGER", account_status: "ACTIVE" },
    ]) {
        resetFixture();
        const reportId = await createAndSubmit();
        fixture.identities.set("regulator-1", identity);
        const result = response();
        await regulator.reviewComplianceReport({
            user: { userId: "regulator-1" },
            params: { reportId },
            body: { submission_id: latestSubmissionId(reportId), decision: "ACCEPTED" },
        }, result);
        assert.equal(result.statusCode, 403);
        assert.equal(fixture.reviews.length, 0);
        assert.equal(fixture.reports.get(reportId).rba_status, "SUBMITTED");
    }
});

test("regulator report listing returns submitted reports and binds each supported filter", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const res = response();
    await regulator.listReports({
        user: { userId: "regulator-1" },
        query: {
            fund_id: "fund-1",
            manager_id: "manager-1",
            report_type: "RBA",
            status: "SUBMITTED",
            period_start: "2026-01-01",
            period_end: "2026-03-31",
            search: "Worker",
        },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data[0].report_id, reportId);
    assert.match(fixture.lastQuery, /cr\.rba_status <> 'DRAFT'/);
    assert.match(fixture.lastQuery, /rfa\.regulator_user_id = \$1/);
    assert.match(fixture.lastQuery, /cr\.fund_id = \$2/);
    assert.match(fixture.lastQuery, /cr\.generated_by = \$3/);
    assert.match(fixture.lastQuery, /cr\.report_type = \$4/);
    assert.match(fixture.lastQuery, /cr\.rba_status = \$5/);
    assert.match(fixture.lastQuery, /cr\.period_end >= \$6/);
    assert.match(fixture.lastQuery, /cr\.period_start <= \$7/);
    assert.deepEqual(fixture.lastValues, [
        "regulator-1", "fund-1", "manager-1", "RBA", "SUBMITTED",
        "2026-01-01", "2026-03-31", "%Worker%", "%Worker%",
    ]);
});

test("legacy reports outside assigned funds remain hidden from regulator list and detail", async () => {
    resetFixture();
    fixture.reports.set("legacy-report", {
        report_id: "legacy-report",
        generated_by: "former-manager",
        fund_id: null,
        report_type: "RBA",
        period_start: null,
        period_end: null,
        report_content: {},
        rba_status: "DRAFT",
        is_legacy: true,
        generated_at: "2020-01-01T00:00:00Z",
        submitted_at: null,
        last_submitted_at: null,
    });

    const regulatorList = response();
    await regulator.listReports({ user: { userId: "regulator-1" }, query: {} }, regulatorList);
    assert.equal(regulatorList.body.data.length, 0);

    const regulatorDetail = response();
    await regulator.getComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId: "legacy-report" },
    }, regulatorDetail);
    assert.equal(regulatorDetail.statusCode, 404);

    const review = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId: "legacy-report" },
        body: { decision: "ACCEPTED" },
    }, review);
    assert.equal(review.statusCode, 404);

    const managerList = response();
    await workflow.listManagerReports({ user: { userId: "manager-1" } }, managerList);
    assert.equal(managerList.body.data.some((row) => row.report_id === "legacy-report"), false);
    assert.equal(fixture.submissions.length, 0);
});

test("duplicate submission requests and competing regulator decisions are rejected after the first transition", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const duplicateSubmission = response();
    await workflow.submitReport({
        user: { userId: "manager-1" },
        params: { reportId },
    }, duplicateSubmission);
    assert.equal(duplicateSubmission.statusCode, 409);
    assert.equal(fixture.submissions.length, 1);
    assert.equal(fixture.notifications.length, 2);

    fixture.regulatorAssignments.get("regulator-2").add("fund-1");
    const concurrentDecisions = await Promise.all(["regulator-1", "regulator-2"].map(async (userId) => {
        const res = response();
        await regulator.reviewComplianceReport({
            user: { userId },
            params: { reportId },
            body: { submission_id: latestSubmissionId(reportId), decision: "ACCEPTED" },
        }, res);
        return res;
    }));
    assert.deepEqual(concurrentDecisions.map((res) => res.statusCode).sort(), [200, 409]);
    assert.equal(fixture.reviews.length, 1);
    assert.equal(fixture.reports.get(reportId).rba_status, "ACCEPTED");
});

test("failed submission notification and review audit insertions roll back workflow writes", async () => {
    resetFixture();
    const created = response();
    await workflow.createDraft({ user: { userId: "manager-1" }, body: completeReport }, created);
    const reportId = created.body.data.report.report_id;
    const initialAuditCount = fixture.audits.length;

    fixture.failOn = "INSERT INTO notifications";
    const failedSubmission = response();
    await workflow.submitReport({
        user: { userId: "manager-1" }, params: { reportId },
    }, failedSubmission);
    fixture.failOn = null;
    assert.equal(failedSubmission.statusCode, 500);
    assert.equal(fixture.reports.get(reportId).rba_status, "DRAFT");
    assert.equal(fixture.submissions.length, 0);
    assert.equal(fixture.notifications.length, 0);
    assert.equal(fixture.audits.length, initialAuditCount);

    const submitted = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, submitted);
    assert.equal(submitted.statusCode, 200);
    const preReviewAuditCount = fixture.audits.length;
    const preReviewNotificationCount = fixture.notifications.length;
    fixture.failOn = "INSERT INTO audit_logs";
    const failedReview = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: {
            submission_id: latestSubmissionId(reportId),
            decision: "REJECTED",
            reason: "Please correct the balance reconciliation.",
        },
    }, failedReview);
    fixture.failOn = null;

    assert.equal(failedReview.statusCode, 500);
    assert.equal(fixture.reports.get(reportId).rba_status, "SUBMITTED");
    assert.equal(fixture.reviews.length, 0);
    assert.equal(fixture.notifications.length, preReviewNotificationCount);
    assert.equal(fixture.audits.length, preReviewAuditCount);
});

test("regulator acceptance is audited, notifies only the submitter, and final reports cannot be reviewed again", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const accepted = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { submission_id: latestSubmissionId(reportId), decision: "ACCEPTED" },
    }, accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(fixture.reports.get(reportId).rba_status, "ACCEPTED");
    assert.deepEqual(fixture.notifications.at(-1), {
        user_id: "manager-1",
        created_by: "regulator-1",
        message: `Compliance report ${reportId}: accepted.`,
    });
    assert.equal(fixture.audits.at(-1).action_type, "APPROVE");
    assert.deepEqual(fixture.audits.at(-1).details, {
        actor_user_id: "regulator-1",
        actor_role: "REGULATOR",
        from_status: "SUBMITTED",
        to_status: "ACCEPTED",
        submission_version: 1,
        reason: null,
    });

    const secondReview = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: {
            submission_id: latestSubmissionId(reportId),
            decision: "REJECTED",
            reason: "Requires changes",
        },
    }, secondReview);
    assert.equal(secondReview.statusCode, 409);
    assert.equal(fixture.reviews.length, 1);
});

test("revision requests preserve prior decisions and allow manager resubmission as a new version", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const requested = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: {
            submission_id: latestSubmissionId(reportId),
            decision: "REVISION_REQUESTED",
            reason: "Please clarify the reported risk controls.",
        },
    }, requested);
    assert.equal(requested.statusCode, 200);

    const duplicateDecision = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { submission_id: latestSubmissionId(reportId), decision: "ACCEPTED" },
    }, duplicateDecision);
    assert.equal(duplicateDecision.statusCode, 409);
    assert.equal(fixture.reviews.length, 1);

    const revisedContent = {
        ...completeReport,
        report_content: {
            ...completeReport.report_content,
            risk_and_governance: "Updated detail clarifies risk controls and oversight responsibilities.",
        },
    };
    const revised = response();
    await workflow.updateDraft({ user: { userId: "manager-1" }, params: { reportId }, body: revisedContent }, revised);
    assert.equal(revised.statusCode, 200);
    const resubmitted = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, resubmitted);
    assert.equal(resubmitted.statusCode, 200);
    assert.equal(fixture.reports.get(reportId).rba_status, "SUBMITTED");
    assert.deepEqual(fixture.submissions.map((submission) => submission.version), [1, 2]);
    assert.equal(fixture.reviews.length, 1);
    assert.equal(fixture.reviews[0].decision, "REVISION_REQUESTED");
    assert.equal(fixture.notifications[2].user_id, "manager-1");
    assert.equal(fixture.audits.at(-1).action_type, "RESUBMIT");

    const finalDecision = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: {
            submission_id: latestSubmissionId(reportId),
            decision: "REJECTED",
            reason: "Insufficient evidence.",
        },
    }, finalDecision);
    assert.equal(finalDecision.statusCode, 200);
    assert.equal(fixture.reviews.length, 2);
    assert.equal(fixture.reviews[0].reason, "Please clarify the reported risk controls.");
    assert.equal(fixture.reviews[1].reason, "Insufficient evidence.");
});

test("regulator decisions require the viewed submission and reject stale versions", async () => {
    resetFixture();
    const reportId = await createAndSubmit();
    const firstSubmissionId = latestSubmissionId(reportId);

    const missingVersion = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { decision: "ACCEPTED" },
    }, missingVersion);
    assert.equal(missingVersion.statusCode, 400);
    assert.equal(fixture.reviews.length, 0);

    const requested = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: {
            submission_id: firstSubmissionId,
            decision: "REVISION_REQUESTED",
            reason: "Please clarify the reported risk controls.",
        },
    }, requested);
    assert.equal(requested.statusCode, 200);

    const revised = response();
    await workflow.updateDraft({
        user: { userId: "manager-1" },
        params: { reportId },
        body: completeReport,
    }, revised);
    assert.equal(revised.statusCode, 200);
    const resubmitted = response();
    await workflow.submitReport({ user: { userId: "manager-1" }, params: { reportId } }, resubmitted);
    assert.equal(resubmitted.statusCode, 200);
    const secondSubmissionId = latestSubmissionId(reportId);
    assert.notEqual(secondSubmissionId, firstSubmissionId);

    const staleDecision = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { submission_id: firstSubmissionId, decision: "ACCEPTED" },
    }, staleDecision);
    assert.equal(staleDecision.statusCode, 409);
    assert.equal(staleDecision.body.code, "STALE_SUBMISSION");
    assert.equal(fixture.reviews.length, 1);
    assert.equal(fixture.reports.get(reportId).rba_status, "SUBMITTED");

    const currentDecision = response();
    await regulator.reviewComplianceReport({
        user: { userId: "regulator-1" },
        params: { reportId },
        body: { submission_id: secondSubmissionId, decision: "ACCEPTED" },
    }, currentDecision);
    assert.equal(currentDecision.statusCode, 200);
    assert.equal(fixture.reviews[0].submission_id, firstSubmissionId);
    assert.equal(fixture.reviews[1].submission_id, secondSubmissionId);
    assert.equal(currentDecision.body.data.submission_version, 2);
});

test("HTTP role checks prohibit regulators from submitting and workers/managers from reviewing", async () => {
    resetFixture();
    fixture.notifications.push(
        { user_id: "manager-1", message: "Manager-only notification" },
        { user_id: "regulator-1", message: "Regulator-only notification" }
    );
    const app = express();
    app.use(express.json());
    app.use("/api/compliance-reports", complianceRoutes);
    app.use("/api/regulator", regulatorRoutes);
    app.use("/api/notifications", notificationRoutes);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const token = (userId) => generateToken({ userId, authVersion: 0 });
    const request = (path, userId, method = "GET") => fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token(userId)}`, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ decision: "ACCEPTED" }),
    });

    try {
        assert.equal((await request("/api/compliance-reports", "regulator-1", "POST")).status, 403);
        assert.equal((await request("/api/regulator/reports/report-1/review", "manager-1", "POST")).status, 403);
        assert.equal((await request("/api/regulator/reports/report-1/review", "worker-1", "POST")).status, 403);
        assert.equal((await request("/api/compliance-reports", "worker-1")).status, 403);
        assert.equal((await request("/api/compliance-reports", "admin-1")).status, 403);
        assert.equal((await request("/api/regulator/reports", "admin-1")).status, 403);
        const inbox = await request("/api/notifications/my", "regulator-1");
        assert.equal(inbox.status, 200);
        assert.deepEqual((await inbox.json()).data.map((notification) => notification.message), ["Regulator-only notification"]);
        const managerInbox = await request("/api/notifications/my", "manager-1");
        assert.equal(managerInbox.status, 200);
        assert.deepEqual((await managerInbox.json()).data.map((notification) => notification.message), ["Manager-only notification"]);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test("canonical schema and migration declare append-only composite-linked history and legacy preflight", () => {
    const root = path.resolve(__dirname, "../../..");
    const schema = fs.readFileSync(path.join(root, "database", "schema.sql"), "utf8");
    const migration = fs.readFileSync(path.join(root, "database", "migration_compliance_review_workflow.sql"), "utf8");
    const snapshotMigration = fs.readFileSync(
        path.join(root, "database", "migration_compliance_actor_snapshots.sql"),
        "utf8"
    );

    for (const sql of [schema, migration]) {
        assert.match(sql, /UNIQUE \(submission_id, report_id\)/);
        assert.match(sql, /FOREIGN KEY \(submission_id, report_id\)/);
        assert.match(sql, /BEFORE UPDATE OR DELETE ON compliance_report_submissions/);
        assert.match(sql, /BEFORE UPDATE OR DELETE ON compliance_report_reviews/);
        assert.match(sql, /BEFORE TRUNCATE ON compliance_report_submissions/);
        assert.match(sql, /BEFORE TRUNCATE ON compliance_report_reviews/);
        assert.match(sql, /submitted_by VARCHAR\(25\) NOT NULL/);
        assert.match(sql, /submitted_by_name VARCHAR\(100\) NOT NULL/);
        assert.match(sql, /submitted_by_role VARCHAR\(20\) NOT NULL/);
        assert.match(sql, /reviewed_by VARCHAR\(25\) NOT NULL/);
        assert.match(sql, /reviewed_by_name VARCHAR\(100\) NOT NULL/);
        assert.match(sql, /reviewed_by_role VARCHAR\(20\) NOT NULL/);
    }
    assert.match(migration, /expected pre-workflow/);
    assert.match(migration, /workflow tables already exist/);
    assert.match(migration, /ADD COLUMN is_legacy BOOLEAN NOT NULL DEFAULT TRUE/);
    assert.match(schema, /is_legacy\s+BOOLEAN NOT NULL DEFAULT FALSE/);
    assert.match(snapshotMigration, /Existing history is preserved without fabricated names/);
    assert.match(snapshotMigration, /Actor snapshot columns already exist/);
    assert.match(snapshotMigration, /ADD COLUMN submitted_by_name VARCHAR\(100\)/);
    assert.match(snapshotMigration, /ADD COLUMN reviewed_by_name VARCHAR\(100\)/);
});
