const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    createNotificationRepository,
} = require("../src/services/notificationRepository");
const {
    createReportService,
    csvSafe,
    exportReport,
    validateFilters,
} = require("../src/services/reportService");
const {
    createRegulatorFundAssignmentRepository,
} = require("../src/services/regulatorFundAssignmentRepository");

const REQUEST_ID = "4c3b9f30-7cb7-4b2f-83d1-1f24c9b2b1d5";

function createRolePool({
    scopeFundId = "fund-1",
    recipientRole = "WORKER",
    recipientIds = ["recipient-1"],
} = {}) {
    const calls = [];
    const state = { notifications: [], audit: [] };
    const client = {
        async query(sql, params = []) {
            calls.push([sql, params]);
            if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
            if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
            if (sql.includes("SELECT count(DISTINCT request_id)::integer AS request_count")) {
                return { rows: [{ request_count: 0 }] };
            }
            if (sql.includes("SELECT DISTINCT recipient_user_id")) {
                return {
                    rows: state.audit
                        .filter((entry) => entry.params[0] === params[0] &&
                            entry.params[1] === params[1] && entry.params[3])
                        .map((entry) => ({ recipient_user_id: entry.params[3] })),
                };
            }
            if (sql.includes("FROM regulator_fund_assignments") ||
                sql.includes("JOIN fund_allocations fa ON fa.account_id = pa.account_id")) {
                return { rows: scopeFundId ? [{ fund_id: scopeFundId }] : [] };
            }
            if (sql.includes("FROM users") && sql.includes("FOR SHARE")) {
                const recipientId = params[0];
                if (!recipientIds.includes(recipientId)) return { rows: [] };
                return {
                    rows: [{
                        user_id: recipientId,
                        full_name: "Recipient One",
                        phone: "0712345678",
                        email: "worker@example.test",
                        email_verified: true,
                        role: recipientRole,
                    }],
                };
            }
            if (sql.includes("INSERT INTO notifications")) {
                if (state.notifications.some((row) =>
                    row.admin_request_key === params[9] &&
                    row.user_id === params[0] &&
                    row.notification_type === params[2])) {
                    return { rows: [], rowCount: 0 };
                }
                const row = {
                    notification_id: `notification-${state.notifications.length + 1}`,
                    user_id: params[0],
                    created_by: params[1],
                    notification_type: params[2],
                    message: params[3],
                    email_subject: params[6],
                    email_html_body: params[7],
                    push_title: params[8],
                    notification_category: params[10],
                    scope_fund_id: params[11],
                    admin_request_key: params[9],
                    delivery_status: "PENDING",
                };
                state.notifications.push(row);
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("SELECT notification_id, user_id, created_by")) {
                return {
                    rows: state.notifications.filter((row) =>
                        row.admin_request_key === params[0] && row.user_id === params[1]),
                };
            }
            if (sql.includes("INSERT INTO notification_audit_events")) {
                state.audit.push({ sql, params });
                return { rows: [], rowCount: 1 };
            }
            if (sql.includes("INSERT INTO audit_logs")) return { rows: [], rowCount: 1 };
            throw new Error(`Unexpected SQL in role notification test: ${sql}`);
        },
        release() {},
    };
    return {
        calls,
        state,
        pool: {
            async connect() { return client; },
            async query(sql, params = []) {
                calls.push([sql, params]);
                if (sql.includes("SELECT DISTINCT recipient_user_id")) {
                    return {
                        rows: state.audit
                            .filter((entry) => entry.params[0] === params[0] &&
                                entry.params[1] === params[1] && entry.params[3])
                            .map((entry) => ({ recipient_user_id: entry.params[3] })),
                    };
                }
                if (sql.includes("FROM users u") && sql.includes("ANY($1::varchar[])")) {
                    return {
                            rows: recipientIds.map((recipientId) => ({
                                user_id: recipientId,
                                phone: "0712345678",
                                email: "worker@example.test",
                                email_verified: true,
                                has_push_subscription: false,
                            })).filter((recipient) => params[0].includes(recipient.user_id)),
                    };
                }
                return { rows: [] };
            },
        },
    };
}

test("Fund Manager notifications require an active assigned-fund worker and record the scoped sender", async () => {
    const { pool, state, calls } = createRolePool();
    const repository = createNotificationRepository(pool);
    const result = await repository.queueRoleNotifications({
        senderId: "manager-1",
        senderRole: "FUND_MANAGER",
        userId: "recipient-1",
        fundId: "fund-1",
        category: "CONTRIBUTION_REMINDER",
        channels: ["SMS"],
        message: "Please review your contribution.",
        requestId: REQUEST_ID,
    });

    assert.equal(result[0].scope_fund_id, "fund-1");
    assert.equal(state.notifications[0].created_by, "manager-1");
    assert.equal(state.notifications[0].notification_category, "CONTRIBUTION_REMINDER");
    assert.deepEqual(state.audit[0].params.slice(1, 6), [
        "manager-1", "FUND_MANAGER", "recipient-1", "fund-1", "CONTRIBUTION_REMINDER",
    ]);
    assert.deepEqual(JSON.parse(state.audit[0].params[7]), ["notification-1"]);
    assert.match(calls.find(([sql]) => sql.includes("JOIN fund_allocations"))[0], /f\.managed_by = \$2/);
});

test("Fund Manager cannot target a worker outside managed funds", async () => {
    const { pool, state } = createRolePool({ scopeFundId: null });
    const repository = createNotificationRepository(pool);

    await assert.rejects(() => repository.queueRoleNotifications({
        senderId: "manager-1",
        senderRole: "FUND_MANAGER",
        userId: "recipient-1",
        category: "SCHEME_UPDATE",
        channels: ["SMS"],
        message: "Update",
        requestId: REQUEST_ID,
    }), { code: "NOTIFICATION_FORBIDDEN", statusCode: 403 });

    assert.equal(state.notifications.length, 0);
    assert.equal(state.audit.length, 1);
    assert.match(state.audit[0].sql, /'DENIED', 'RECIPIENT_OUT_OF_SCOPE'/);
});

test("admin announcements queue for multiple recipients with recipient-scoped idempotency", async () => {
    const { pool, state, calls } = createRolePool({
        scopeFundId: null,
        recipientIds: ["recipient-1", "recipient-2"],
    });
    const repository = createNotificationRepository(pool);
    const input = {
        senderId: "admin-1",
        senderRole: "ADMIN",
        userIds: ["recipient-1", "recipient-2"],
        category: "ANNOUNCEMENT",
        channels: ["SMS"],
        message: "Service update",
        requestId: REQUEST_ID,
    };

    const first = await repository.queueRoleNotifications(input);
    const retry = await repository.queueRoleNotifications(input);

    assert.equal(first.length, 2);
    assert.deepEqual(first.map((item) => item.recipient_user_id), ["recipient-1", "recipient-2"]);
    assert.deepEqual(retry.map((item) => item.notification_id), first.map((item) => item.notification_id));
    assert.equal(state.notifications.length, 2);
    assert.equal(state.audit.length, 2);
    assert.equal(
        state.notifications[0].admin_request_key,
        state.notifications[1].admin_request_key
    );
    await repository.listNotificationAudit({ userId: "admin-1", role: "ADMIN" });
    assert.match(
        calls.find(([sql]) => sql.includes("AS delivery_results"))[0],
        /n\.notification_id = audit_notification_id\.notification_id/
    );
    assert.match(
        calls.find(([sql]) => sql.includes("AS delivery_results"))[0],
        /jsonb_array_elements_text\(nae\.notification_ids\)/
    );
    await assert.rejects(() => repository.queueRoleNotifications({
        ...input,
        userIds: ["recipient-1"],
    }), { code: "NOTIFICATION_IDEMPOTENCY_CONFLICT", statusCode: 409 });
});

test("recipient search and audit views are scoped and never return unmasked contacts", async () => {
    const queries = [];
    const repository = createNotificationRepository({
        async query(sql, params = []) {
            queries.push([sql, params]);
            return { rows: [] };
        },
        async connect() { throw new Error("Not expected"); },
    });

    await repository.listRoleRecipients({
        senderId: "manager-1",
        senderRole: "FUND_MANAGER",
        search: "worker",
    });
    await repository.listNotificationAudit({
        userId: "manager-1",
        role: "FUND_MANAGER",
    });

    const recipientQuery = queries[0][0];
    assert.match(recipientQuery, /f\.managed_by = \$1/);
    assert.doesNotMatch(recipientQuery, /u\.phone\s*,|u\.email\s*,/);
    assert.match(queries[1][0], /f\.managed_by = \$1/);
    assert.match(queries[1][0], /recipient_email_masked/);
    assert.match(queries[1][0], /recipient_phone_masked/);
    assert.doesNotMatch(queries[1][0], /ELSE NULL END,\s*\)/);
});

test("notification audit requires current fund scope even when the caller sent the event", async () => {
    const assignments = [{ regulatorId: "regulator-1", fundId: "fund-1", active: true }];
    const fundOwners = new Map([["fund-1", "manager-1"]]);
    const auditEvents = [
        { audit_event_id: "scoped", sender_user_id: "regulator-1", scope_fund_id: "fund-1" },
        { audit_event_id: "global", sender_user_id: "regulator-1", scope_fund_id: null },
    ];
    const queries = [];
    const repository = createNotificationRepository({
        async query(sql, params = []) {
            queries.push({ sql, params });
            const userId = params[0];
            const role = sql.includes("regulator_fund_assignments") ? "REGULATOR" : "FUND_MANAGER";
            return {
                rows: auditEvents.filter((event) => {
                    if (event.scope_fund_id === null) return event.sender_user_id === userId;
                    if (role === "REGULATOR") {
                        return assignments.some((assignment) =>
                            assignment.regulatorId === userId &&
                            assignment.fundId === event.scope_fund_id &&
                            assignment.active
                        );
                    }
                    return fundOwners.get(event.scope_fund_id) === userId;
                }),
            };
        },
        async connect() { throw new Error("Not expected"); },
    });

    const assigned = await repository.listNotificationAudit({
        userId: "regulator-1",
        role: "REGULATOR",
    });
    assert.deepEqual(assigned.map(({ audit_event_id }) => audit_event_id), ["scoped", "global"]);
    assert.match(queries[0].sql, /nae\.scope_fund_id IS NULL AND nae\.sender_user_id = \$1/);
    assert.match(queries[0].sql, /rfa\.regulator_user_id = \$1 AND rfa\.active = TRUE/);
    assert.doesNotMatch(queries[0].sql, /nae\.sender_user_id = \$1 OR EXISTS/);

    assignments[0].active = false;
    const revoked = await repository.listNotificationAudit({
        userId: "regulator-1",
        role: "REGULATOR",
    });
    assert.deepEqual(revoked.map(({ audit_event_id }) => audit_event_id), ["global"]);
    assert.equal(revoked.some(({ audit_event_id }) => audit_event_id === "scoped"), false);

    const managerOwned = await repository.listNotificationAudit({
        userId: "manager-1",
        role: "FUND_MANAGER",
    });
    assert.deepEqual(managerOwned.map(({ audit_event_id }) => audit_event_id), ["scoped"]);
    assert.match(queries[2].sql, /nae\.scope_fund_id IS NULL AND nae\.sender_user_id = \$1/);
    assert.match(queries[2].sql, /f\.fund_id = nae\.scope_fund_id AND f\.managed_by = \$1/);

    fundOwners.set("fund-1", "manager-2");
    const formerManager = await repository.listNotificationAudit({
        userId: "manager-1",
        role: "FUND_MANAGER",
    });
    assert.deepEqual(formerManager, []);
});

test("Regulator categories are independent from manager categories and use assigned funds", async () => {
    const { pool, state, calls } = createRolePool({ recipientRole: "FUND_MANAGER" });
    const repository = createNotificationRepository(pool);

    await assert.rejects(() => repository.queueRoleNotifications({
        senderId: "regulator-1",
        senderRole: "REGULATOR",
        userId: "recipient-1",
        fundId: "fund-1",
        category: "SCHEME_UPDATE",
        channels: ["SMS"],
        message: "Update",
        requestId: REQUEST_ID,
    }), { code: "NOTIFICATION_CATEGORY_FORBIDDEN", statusCode: 403 });

    const result = await repository.queueRoleNotifications({
        senderId: "regulator-1",
        senderRole: "REGULATOR",
        userId: "recipient-1",
        fundId: "fund-1",
        category: "REGULATORY_ADVISORY",
        channels: ["SMS"],
        message: "Regulatory update",
        requestId: REQUEST_ID,
    });
    assert.equal(result[0].scope_fund_id, "fund-1");
    assert.match(calls.find(([sql]) => sql.includes("FROM regulator_fund_assignments"))[0], /rfa\.active = TRUE/);
    assert.equal(state.notifications[0].notification_category, "REGULATORY_ADVISORY");
});

test("report query enforces managed-fund scope and settled records only", async () => {
    const calls = [];
    const pool = {
        async query(sql, params = []) {
            calls.push([sql, params]);
            if (sql.includes("SELECT fund_id FROM funds WHERE managed_by")) {
                return { rows: [{ fund_id: "fund-1" }] };
            }
            if (sql.includes("WITH report_data AS")) {
                return { rows: [{ contribution_id: "contribution-1", amount: "20.00" }] };
            }
            if (sql.includes("INSERT INTO report_generation_history")) {
                return { rows: [{ report_id: REQUEST_ID, generated_at: "2026-11-04T00:00:00Z" }] };
            }
            if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
            throw new Error(`Unexpected report SQL: ${sql}`);
        },
    };
    const reports = createReportService(pool);
    const report = await reports.generate({
        userId: "manager-1",
        role: "FUND_MANAGER",
        reportKey: "settled-contributions",
        filters: { start_date: "2026-11-01", fund_id: "fund-1" },
        format: "CSV",
    });

    assert.equal(report.reportId, REQUEST_ID);
    assert.equal(report.extension, "csv");
    const query = calls.find(([sql]) => sql.includes("WITH report_data AS"));
    assert.match(query[0], /c\.contribution_status = 'COMPLETED'/);
    assert.match(query[0], /t\.transaction_status = 'COMPLETED'/);
    assert.match(query[0], /pension_account_movements/);
    assert.match(query[0], /m\.movement_type = 'CONTRIBUTION_SETTLEMENT'/);
    assert.match(query[0], /payment_provider/);
    assert.deepEqual(query[1][6], ["fund-1"]);
});

test("compliance exports hide drafts only for regulators and preserve legacy visibility", async () => {
    async function generateComplianceExport(role) {
        const calls = [];
        const reports = createReportService({
            async query(sql, params = []) {
                calls.push([sql, params]);
                if (sql.includes("SELECT f.fund_id FROM regulator_fund_assignments")) {
                    return { rows: [{ fund_id: "fund-1" }] };
                }
                if (sql.includes("SELECT fund_id FROM funds WHERE managed_by")) {
                    return { rows: [{ fund_id: "fund-1" }] };
                }
                if (sql.includes("WITH report_data AS")) return { rows: [] };
                if (sql.includes("INSERT INTO report_generation_history")) {
                    return { rows: [{ report_id: REQUEST_ID, generated_at: "2026-11-04T00:00:00Z" }] };
                }
                if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
                throw new Error(`Unexpected report SQL: ${sql}`);
            },
        });
        await reports.generate({
            userId: `${role.toLowerCase()}-1`,
            role,
            reportKey: "compliance",
            filters: {},
            format: "CSV",
        });
        return calls.find(([sql]) => sql.includes("WITH report_data AS"))[0];
    }

    const regulatorQuery = await generateComplianceExport("REGULATOR");
    const managerQuery = await generateComplianceExport("FUND_MANAGER");
    const adminQuery = await generateComplianceExport("ADMIN");
    assert.match(regulatorQuery, /WHERE \(cr\.is_legacy = TRUE OR cr\.rba_status <> 'DRAFT'\)/);
    assert.doesNotMatch(managerQuery, /cr\.is_legacy = TRUE OR cr\.rba_status <> 'DRAFT'/);
    assert.doesNotMatch(adminQuery, /cr\.is_legacy = TRUE OR cr\.rba_status <> 'DRAFT'/);
});

test("report generation rejects a fund outside the caller scope before querying report data", async () => {
    let reportQueryCalled = false;
    const reports = createReportService({
        async query(sql) {
            if (sql.includes("SELECT fund_id FROM funds WHERE managed_by")) {
                return { rows: [{ fund_id: "fund-1" }] };
            }
            if (sql.includes("WITH report_data AS")) reportQueryCalled = true;
            return { rows: [] };
        },
    });

    test("M-Pesa export distinguishes verification from settlement and filters transaction status", async () => {
        const calls = [];
        const reports = createReportService({
            async query(sql, params = []) {
                calls.push([sql, params]);
                if (sql.includes("WITH report_data AS")) return { rows: [] };
                if (sql.includes("INSERT INTO report_generation_history")) {
                    return { rows: [{ report_id: REQUEST_ID, generated_at: "2026-11-04T00:00:00Z" }] };
                }
                return { rows: [] };
            },
        });

        await reports.generate({
            userId: "admin-1",
            role: "ADMIN",
            reportKey: "mpesa-payments",
            filters: { transaction_status: "COMPLETED" },
            format: "CSV",
        });
        const query = calls.find(([sql]) => sql.includes("WITH report_data AS"));
        assert.match(query[0], /mpesa_payment_verifications/);
        assert.match(query[0], /bool_or\(verification_status = 'VERIFIED_SUCCESS'\)/);
        assert.match(query[0], /CASE a\.provider_mode/);
        assert.doesNotMatch(query[0], /checkout_request_id LIKE 'SIM%'/);
        assert.match(query[0], /pension_account_movements/);
        assert.match(query[0], /transaction_status::text = \$9/);
        assert.equal(query[1][8], "COMPLETED");
    });

    await assert.rejects(() => reports.generate({
        userId: "manager-1",
        role: "FUND_MANAGER",
        reportKey: "contributions",
        filters: { fund_id: "another-fund" },
        format: "CSV",
    }), { code: "REPORT_FORBIDDEN", statusCode: 403 });
    assert.equal(reportQueryCalled, false);
});

test("report formats are generated and CSV formula injection is escaped", async () => {
    assert.equal(csvSafe("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvSafe(-12.5), '"-12.5"');
    const rows = [{ value: "=1+1", amount: -12.5 }];
    const csv = await exportReport("users", rows, "CSV");
    const xlsx = await exportReport("users", rows, "XLSX");
    const pdf = await exportReport("users", rows, "PDF");
    assert.match(csv.buffer.toString("utf8"), /'=1\+1/);
    assert.equal(xlsx.buffer.subarray(0, 2).toString("ascii"), "PK");
    assert.equal(pdf.buffer.subarray(0, 4).toString("ascii"), "%PDF");
});

test("report filters validate date ordering and exact calendar dates", () => {
    assert.throws(() => validateFilters({ start_date: "2026-11-31" }), {
        code: "REPORT_INVALID_FILTERS",
    });
    assert.throws(() => validateFilters({
        start_date: "2026-11-05",
        end_date: "2026-11-04",
    }), { code: "REPORT_INVALID_FILTERS" });
    assert.throws(() => validateFilters({ transaction_status: "completed; SELECT" }), {
        code: "REPORT_INVALID_FILTERS",
    });
});

test("regulator fund assignments are admin-attributed and revoked without deleting history", async () => {
    const calls = [];
    const client = {
        async query(sql, params = []) {
            calls.push([sql, params]);
            if (sql.includes("INSERT INTO regulator_fund_assignments")) {
                return {
                    rows: [{
                        assignment_id: "assignment-1",
                        regulator_user_id: "regulator-1",
                        fund_id: "fund-1",
                        active: true,
                    }],
                };
            }
            if (sql.includes("UPDATE regulator_fund_assignments")) {
                return { rows: [{ assignment_id: "assignment-1" }] };
            }
            return { rows: [] };
        },
        release() {},
    };
    const repository = createRegulatorFundAssignmentRepository({
        async query() { throw new Error("Not expected"); },
        async connect() { return client; },
    });

    await repository.assign({
        adminId: "admin-1",
        regulatorId: "regulator-1",
        fundId: "fund-1",
    });
    await repository.revoke({
        adminId: "admin-1",
        regulatorId: "regulator-1",
        fundId: "fund-1",
    });

    const insert = calls.find(([sql]) => sql.includes("INSERT INTO regulator_fund_assignments"));
    const revoke = calls.find(([sql]) => sql.includes("UPDATE regulator_fund_assignments"));
    assert.match(insert[0], /u\.role = 'REGULATOR'/);
    assert.deepEqual(insert[1], ["admin-1", "regulator-1", "fund-1"]);
    assert.match(revoke[0], /SET active = FALSE/);
    assert.doesNotMatch(revoke[0], /DELETE FROM/);
    assert.equal(calls.filter(([sql]) => sql.includes("INSERT INTO audit_logs")).length, 2);
});

test("notification responses preserve legacy sent_at with provider-acceptance fallback", async () => {
    const calls = [];
    const repository = createNotificationRepository({
        async query(sql) {
            calls.push(sql);
            return { rows: [] };
        },
        async connect() {
            throw new Error("Not expected");
        },
    });

    await repository.listAdminNotifications();
    await repository.listUserNotifications("worker-1");

    assert.equal(calls.length, 2);
    assert.match(calls[0], /provider_message_id/);
    assert.match(calls[0], /delivered_at/);
    assert.match(calls[0], /last_error_code/);
    for (const sql of calls) {
        assert.match(sql, /COALESCE\((?:n\.)?sent_at,\s*(?:n\.)?provider_accepted_at\)\s+AS\s+sent_at/);
        assert.match(sql, /provider_accepted_at/);
    }
});

test("notification report filters match legacy SENT and expanded PROVIDER_ACCEPTED statuses", async () => {
    const calls = [];
    const reports = createReportService({
        async query(sql, params = []) {
            calls.push([sql, params]);
            if (sql.includes("WITH report_data AS")) return { rows: [] };
            if (sql.includes("INSERT INTO report_generation_history")) {
                return { rows: [{ report_id: REQUEST_ID, generated_at: "2026-11-04T00:00:00Z" }] };
            }
            if (sql.includes("INSERT INTO report_download_events")) return { rows: [] };
            throw new Error(`Unexpected report SQL: ${sql}`);
        },
    });

    for (const status of ["SENT", "PROVIDER_ACCEPTED"]) {
        await reports.generate({
            userId: "admin-1",
            role: "ADMIN",
            reportKey: "notification-delivery",
            filters: { delivery_status: status },
            format: "CSV",
        });
    }

    const reportQueries = calls.filter(([sql]) => sql.includes("WITH report_data AS"));
    assert.equal(reportQueries.length, 2);
    assert.ok(reportQueries.every(([sql]) =>
        sql.includes("delivery_status::text IN ('SENT', 'PROVIDER_ACCEPTED')")));
    assert.ok(reportQueries.every(([sql]) =>
        sql.includes("FROM notifications n LEFT JOIN users u ON u.user_id = n.user_id")));
    assert.deepEqual(reportQueries.map(([, params]) => params[10]), ["SENT", "PROVIDER_ACCEPTED"]);
});

test("regulator recipient lookup returns only recipients in active assigned funds", async () => {
    const queries = [];
    let activeAssignments = ["fund-1"];
    const candidates = [
        { user_id: "worker-1", scope_fund_id: "fund-1" },
        { user_id: "worker-2", scope_fund_id: "fund-2" },
    ];
    const repository = createNotificationRepository({
        async query(sql, params = []) {
            queries.push({ sql, params });
            if (sql.includes("WITH authorized_funds")) {
                return {
                    rows: candidates.filter((candidate) =>
                        activeAssignments.includes(candidate.scope_fund_id)),
                };
            }
            throw new Error(`Unexpected recipient query: ${sql}`);
        },
        async connect() {
            throw new Error("Not expected");
        },
    });

    const assigned = await repository.listRoleRecipients({
        senderId: "regulator-1",
        senderRole: "REGULATOR",
        search: "Worker",
    });
    assert.deepEqual(assigned, [{ user_id: "worker-1", scope_fund_id: "fund-1" }]);
    assert.equal(assigned.some(({ user_id }) => user_id === "worker-2"), false);
    assert.match(queries[0].sql, /FROM regulator_fund_assignments/);
    assert.match(queries[0].sql, /regulator_user_id = \$1 AND active = TRUE/);
    assert.match(queries[0].sql, /f\.fund_status = 'ACTIVE'/);
    assert.deepEqual(queries[0].params, ["regulator-1", "%Worker%"]);

    activeAssignments = [];
    const revoked = await repository.listRoleRecipients({
        senderId: "regulator-1",
        senderRole: "REGULATOR",
    });
    assert.deepEqual(revoked, []);
    assert.deepEqual(queries[1].params, ["regulator-1", null]);
});

test("changing a supplied fund identifier cannot bypass regulator recipient scope", async () => {
    const queries = [];
    const repository = createNotificationRepository({
        async query(sql, params = []) {
            queries.push({ sql, params });
            assert.match(sql, /regulator_fund_assignments/);
            assert.match(sql, /rfa\.active = TRUE|active = TRUE/);
            return { rows: [{ user_id: "assigned-worker", scope_fund_id: "fund-1" }] };
        },
        async connect() {
            throw new Error("Not expected");
        },
    });

    const result = await repository.listRoleRecipients({
        senderId: "regulator-1",
        senderRole: "REGULATOR",
        fundId: "unassigned-fund",
    });

    assert.deepEqual(result, [{ user_id: "assigned-worker", scope_fund_id: "fund-1" }]);
    assert.deepEqual(queries[0].params, ["regulator-1", null]);
    assert.equal(JSON.stringify(queries[0].params).includes("unassigned-fund"), false);
});

test("Fund Manager and Admin recipient lookup preserve their separate access rules", async (t) => {
    await t.test("Fund Manager remains scoped to current managed funds", async () => {
        let query;
        const repository = createNotificationRepository({
            async query(sql, params) {
                query = { sql, params };
                return { rows: [{ user_id: "worker-1", scope_fund_id: "fund-1" }] };
            },
            async connect() {
                throw new Error("Not expected");
            },
        });

        const result = await repository.listRoleRecipients({
            senderId: "manager-1",
            senderRole: "FUND_MANAGER",
        });
        assert.equal(result[0].user_id, "worker-1");
        assert.match(query.sql, /f\.managed_by = \$1 AND f\.fund_status = 'ACTIVE'/);
        assert.deepEqual(query.params, ["manager-1", null]);
    });

    await t.test("Admin retains the existing global recipient lookup", async () => {
        let query;
        const repository = createNotificationRepository({
            async query(sql, params) {
                query = { sql, params };
                return { rows: [{ user_id: "recipient-1", role: "WORKER" }] };
            },
            async connect() {
                throw new Error("Not expected");
            },
        });

        const result = await repository.listRoleRecipients({
            senderId: "admin-1",
            senderRole: "ADMIN",
            search: "Recipient",
        });
        assert.equal(result[0].user_id, "recipient-1");
        assert.doesNotMatch(query.sql, /regulator_fund_assignments|managed_by/);
        assert.deepEqual(query.params, ["%Recipient%"]);
    });
});
