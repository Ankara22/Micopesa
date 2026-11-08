const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { Client, Pool } = require("pg");
const { assertTestMode } = require("../../../tests/scripts/testDatabaseSafety");

const SOCKET_DIRECTORY = "/var/run/postgresql";
const DATA_DIRECTORY = "/var/lib/postgresql/18/main";
const DATABASE_PREFIX = "micopesa_api_integration_";
const runTag = crypto.randomBytes(5).toString("hex");
const failures = [];
const warnings = [];
const reportIds = {};
let integrationPool;
let httpServer;

function parseArguments(argv) {
    assertTestMode(process.env);
    const args = {};
    for (let index = 0; index < argv.length; index += 2) {
        const key = argv[index];
        const value = argv[index + 1];
        if (!["--database", "--role"].includes(key) || !value || args[key]) {
            throw new Error("Usage: node tests/complianceWorkflow.integration.cjs --database micopesa_api_integration_<unique> --role <linux-user>");
        }
        args[key] = value;
    }
    if (!args["--database"] || !args["--role"]) {
        throw new Error("Both --database and --role are required; environment-based connection settings are not accepted.");
    }
    if (!new RegExp(`^${DATABASE_PREFIX}[a-z0-9_]+$`).test(args["--database"])) {
        throw new Error(`Database must use the disposable ${DATABASE_PREFIX}<unique_suffix> naming convention.`);
    }
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(args["--role"])) {
        throw new Error("The PostgreSQL role name is invalid.");
    }
    if (args["--role"] !== os.userInfo().username) {
        throw new Error("The PostgreSQL role must match the current Linux user for local peer authentication.");
    }
    return { database: args["--database"], role: args["--role"] };
}

function assertIdentity(identity, expectedDatabase, expectedRole) {
    assert.equal(identity.database, expectedDatabase, "Connected to an unexpected database");
    assert.equal(identity.role, expectedRole, "Connected as an unexpected PostgreSQL role");
    assert.equal(identity.superuser, false, "The API role must not be a superuser");
    assert.equal(identity.address, null, "PostgreSQL connection must use a Unix socket");
    assert.equal(identity.port, null, "PostgreSQL connection must use a Unix socket");
    assert.equal(identity.data_directory, DATA_DIRECTORY, "Unexpected PostgreSQL data directory");
    assert.equal(identity.listen_addresses, "", "PostgreSQL listen_addresses must remain empty");
    assert.equal(Number(identity.version) >= 180000 && Number(identity.version) < 190000, true, "PostgreSQL 18 is required");
}

async function verifyDatabaseIdentity(database, role) {
    const client = new Client({
        host: SOCKET_DIRECTORY,
        port: 5432,
        database,
        user: role,
    });
    await client.connect();
    try {
        const { rows } = await client.query(
            `SELECT current_database() AS database, current_user AS role,
                    inet_server_addr()::text AS address, inet_server_port() AS port,
                    public.compliance_api_integration_data_directory() AS data_directory,
                    current_setting('listen_addresses') AS listen_addresses,
                    current_setting('server_version_num') AS version,
                    (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`
        );
        assertIdentity(rows[0], database, role);
        console.log(`DATABASE_IDENTITY VERIFIED ${JSON.stringify(rows[0])}`);
    } finally {
        await client.end();
    }
}

function connectionString(database, role) {
    return `postgresql://${encodeURIComponent(role)}@localhost:5432/${encodeURIComponent(database)}?host=${encodeURIComponent(SOCKET_DIRECTORY)}`;
}

async function verifyFreshFixtureState(pool) {
    const { rows } = await pool.query(
        `SELECT (SELECT count(*) FROM users)::int AS users,
                (SELECT count(*) FROM funds)::int AS funds,
                (SELECT count(*) FROM compliance_reports)::int AS reports,
                (SELECT count(*) FROM compliance_report_submissions)::int AS submissions,
                (SELECT count(*) FROM compliance_report_reviews)::int AS reviews,
                (SELECT count(*) FROM public.compliance_api_integration_failure_targets)::int AS failure_targets`
    );
    const counts = rows[0];
    for (const [table, count] of Object.entries(counts)) {
        assert.equal(count, 0, `Disposable database is not fresh: ${table} contains ${count} rows`);
    }
}

function reportContent(prefix) {
    return {
        executive_summary: `${prefix} executive summary with enough meaningful detail.`,
        financial_summary: `${prefix} financial summary with enough meaningful detail.`,
        risk_and_governance: `${prefix} risk and governance section with enough detail.`,
        incidents_and_actions: `${prefix} incidents and actions section with enough detail.`,
        supporting_information: `${prefix} supporting information section with enough detail.`,
    };
}

async function seedActors(pool) {
    const digits = String(Number(BigInt(`0x${runTag}`) % 1000000000n)).padStart(9, "0");
    const actors = [
        { key: "manager", suffix: "mgr", name: "Fictional Integration Manager", role: "FUND_MANAGER", status: "ACTIVE" },
        { key: "regulatorOne", suffix: "reg1", name: "Fictional Integration Regulator One", role: "REGULATOR", status: "ACTIVE" },
        { key: "regulatorTwo", suffix: "reg2", name: "Fictional Integration Regulator Two", role: "REGULATOR", status: "ACTIVE" },
        { key: "worker", suffix: "worker", name: "Fictional Integration Worker", role: "WORKER", status: "ACTIVE" },
        { key: "inactiveManager", suffix: "imgr", name: "Fictional Inactive Manager", role: "FUND_MANAGER", status: "INACTIVE" },
        { key: "inactiveRegulator", suffix: "ireg", name: "Fictional Inactive Regulator", role: "REGULATOR", status: "INACTIVE" },
    ];
    for (let index = 0; index < actors.length; index++) {
        const actor = actors[index];
        actor.id = `it${runTag}${actor.suffix}`;
        actor.phone = `+2547${digits.slice(0, 8)}${index}`;
        await pool.query(
            `INSERT INTO users (user_id, full_name, phone, password_hash, role, account_status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [actor.id, actor.name, actor.phone, "integration-fixture-only", actor.role, actor.status]
        );
    }
    const manager = actors.find((actor) => actor.key === "manager");
    const fundId = `it${runTag}fund`;
    await pool.query(
        `INSERT INTO funds (fund_id, managed_by, fund_name, administrator_name, risk_level, expected_return)
         VALUES ($1, $2, $3, $4, 'LOW', 4.25)`,
        [fundId, manager.id, `Fictional Fund ${runTag}`, "Integration Fixture"]
    );
    return {
        actors: Object.fromEntries(actors.map((actor) => [actor.key, actor])),
        fundId,
    };
}

async function runTests(tests) {
    for (const { name, run } of tests) {
        try {
            await run();
            console.log(`PASS ${name}`);
        } catch (error) {
            failures.push({ name, message: error.message, stack: error.stack });
            console.error(`FAIL ${name}: ${error.stack || error.message}`);
        }
    }
}

async function main() {
    const { database, role } = parseArguments(process.argv.slice(2));
    await verifyDatabaseIdentity(database, role);

    process.env.DATABASE_URL = connectionString(database, role);
    process.env.JWT_SECRET = `integration-only-${crypto.randomBytes(32).toString("hex")}`;
    process.env.JWT_EXPIRES_IN = "10m";
    process.on("warning", (warning) => {
        if (warning.message.includes("client is already executing a query")) {
            warnings.push(warning.message);
        }
    });

    const environmentLoader = require.resolve("../src/config/loadEnvironment");
    require.cache[environmentLoader] = {
        id: environmentLoader,
        filename: environmentLoader,
        loaded: true,
        exports: {},
    };

    const pool = require("../src/db/database");
    integrationPool = pool;
    await verifyFreshFixtureState(pool);
    const { actors, fundId } = await seedActors(pool);
    const managerRouter = require("../src/routes/complianceReportRoutes");
    const regulatorRouter = require("../src/routes/regulatorRoutes");
    const { generateToken } = require("../src/utils/token");
    const app = express();
    app.use(express.json());
    app.use("/api/compliance-reports", managerRouter);
    app.use("/api/regulator", regulatorRouter);

    const server = http.createServer(app);
    httpServer = server;
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const tokens = Object.fromEntries(
        Object.values(actors).map((actor) => [actor.id, generateToken({ userId: actor.id })])
    );

    const request = async (actorKey, method, route, body) => {
        const actor = actors[actorKey];
        const response = await fetch(`${baseUrl}${route}`, {
            method,
            headers: {
                Authorization: `Bearer ${tokens[actor.id]}`,
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, payload: await response.json() };
    };
    const createDraft = async (label, complete = true, actorKey = "manager") => {
        const body = {
            fund_id: fundId,
            report_type: complete ? "RBA" : null,
            period_start: complete ? "2026-01-01" : null,
            period_end: complete ? "2026-03-31" : null,
            report_content: complete ? reportContent(label) : {},
        };
        const created = await request(actorKey, "POST", "/api/compliance-reports", body);
        assert.equal(created.status, 201, JSON.stringify(created.payload));
        return created.payload.data.report.report_id;
    };
    const submit = (reportId, actorKey = "manager") =>
        request(actorKey, "POST", `/api/compliance-reports/${reportId}/submit`);
    const createSubmitted = async (label) => {
        const reportId = await createDraft(label);
        const response = await submit(reportId);
        assert.equal(response.status, 200, JSON.stringify(response.payload));
        return reportId;
    };
    const reportState = async (reportId) => {
        const { rows } = await pool.query(
            "SELECT report_id, rba_status FROM compliance_reports WHERE report_id = $1",
            [reportId]
        );
        return rows[0];
    };
    const currentSubmissionId = async (reportId) => {
        const { rows } = await pool.query(
            `SELECT submission_id
             FROM compliance_report_submissions
             WHERE report_id = $1
             ORDER BY version DESC
             LIMIT 1`,
            [reportId]
        );
        assert.ok(rows[0], `No submission exists for report ${reportId}`);
        return rows[0].submission_id;
    };
    const workflowCounts = async (reportId) => {
        const queries = await Promise.all([
            pool.query("SELECT rba_status FROM compliance_reports WHERE report_id = $1", [reportId]),
            pool.query("SELECT count(*)::int AS count FROM compliance_report_submissions WHERE report_id = $1", [reportId]),
            pool.query("SELECT count(*)::int AS count FROM compliance_report_reviews WHERE report_id = $1", [reportId]),
            pool.query("SELECT action_type, count(*)::int AS count FROM audit_logs WHERE entity_id = $1 GROUP BY action_type", [reportId]),
            pool.query("SELECT count(*)::int AS count FROM notifications WHERE message LIKE $1", [`%${reportId}%`]),
        ]);
        return {
            status: queries[0].rows[0]?.rba_status,
            submissions: queries[1].rows[0].count,
            reviews: queries[2].rows[0].count,
            audits: Object.fromEntries(queries[3].rows.map((row) => [row.action_type, row.count])),
            notifications: queries[4].rows[0].count,
        };
    };

    const tests = [
        {
            name: "manager draft, submission, history snapshots, and repeat submission rejection",
            run: async () => {
                const reportId = await createDraft("manager workflow");
                reportIds.accept = reportId;
                assert.equal((await reportState(reportId)).rba_status, "DRAFT");
                const submitted = await submit(reportId);
                assert.equal(submitted.status, 200, JSON.stringify(submitted.payload));
                assert.equal(submitted.payload.data.rba_status, "SUBMITTED");
                assert.equal(submitted.payload.data.submission.version, 1);
                const history = await pool.query(
                    `SELECT version, submitted_by, submitted_by_name, submitted_by_role
                     FROM compliance_report_submissions WHERE report_id = $1`,
                    [reportId]
                );
                assert.deepEqual(history.rows, [{
                    version: 1,
                    submitted_by: actors.manager.id,
                    submitted_by_name: actors.manager.name,
                    submitted_by_role: "FUND_MANAGER",
                }]);
                const repeated = await submit(reportId);
                assert.equal(repeated.status, 409);
            },
        },
        {
            name: "invalid submission remains a draft without submission history",
            run: async () => {
                const reportId = await createDraft("incomplete", false);
                reportIds.incomplete = reportId;
                const response = await submit(reportId);
                assert.equal(response.status, 400);
                assert.equal((await reportState(reportId)).rba_status, "DRAFT");
                const { rows } = await pool.query(
                    "SELECT count(*)::int AS count FROM compliance_report_submissions WHERE report_id = $1",
                    [reportId]
                );
                assert.equal(rows[0].count, 0);
            },
        },
        {
            name: "regulator decisions require the current submission and use authenticated actor identity",
            run: async () => {
                const detail = await request("regulatorOne", "GET", `/api/regulator/reports/${reportIds.accept}`);
                assert.equal(detail.status, 200);
                assert.equal(detail.payload.data.report.reviewable, true);
                const submissionId = await currentSubmissionId(reportIds.accept);
                const missingSubmission = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.accept}/review`, {
                    decision: "ACCEPTED",
                });
                assert.equal(missingSubmission.status, 400);
                const decision = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.accept}/review`, {
                    submission_id: submissionId,
                    decision: "ACCEPTED",
                    reviewed_by: "forged-user-id",
                    reviewed_by_name: "Forged Actor",
                    reviewed_by_role: "FUND_MANAGER",
                });
                assert.equal(decision.status, 200, JSON.stringify(decision.payload));
                const { rows } = await pool.query(
                    `SELECT reviewed_by, reviewed_by_name, reviewed_by_role, decision
                     FROM compliance_report_reviews WHERE report_id = $1`,
                    [reportIds.accept]
                );
                assert.deepEqual(rows, [{
                    reviewed_by: actors.regulatorOne.id,
                    reviewed_by_name: actors.regulatorOne.name,
                    reviewed_by_role: "REGULATOR",
                    decision: "ACCEPTED",
                }]);
            },
        },
        {
            name: "valid rejection reason, invalid decision/reason, and repeated decision",
            run: async () => {
                reportIds.reject = await createSubmitted("rejection workflow");
                const submissionId = await currentSubmissionId(reportIds.reject);
                const invalidDecision = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.reject}/review`, {
                    submission_id: submissionId,
                    decision: "APPROVE",
                });
                assert.equal(invalidDecision.status, 400);
                const shortReason = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.reject}/review`, {
                    submission_id: submissionId,
                    decision: "REJECTED",
                    reason: "No",
                });
                assert.equal(shortReason.status, 400);
                const rejected = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.reject}/review`, {
                    submission_id: submissionId,
                    decision: "REJECTED",
                    reason: "Supporting evidence is incomplete.",
                });
                assert.equal(rejected.status, 200);
                assert.equal((await reportState(reportIds.reject)).rba_status, "REJECTED");
                const repeated = await request("regulatorTwo", "POST", `/api/regulator/reports/${reportIds.reject}/review`, {
                    submission_id: submissionId,
                    decision: "ACCEPTED",
                });
                assert.equal(repeated.status, 409);
            },
        },
        {
            name: "revision, resubmission versioning, and immutable prior review history",
            run: async () => {
                reportIds.revision = await createSubmitted("original submission");
                const firstSubmissionId = await currentSubmissionId(reportIds.revision);
                const revision = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.revision}/review`, {
                    submission_id: firstSubmissionId,
                    decision: "REVISION_REQUESTED",
                    reason: "Please provide clearer supporting information.",
                });
                assert.equal(revision.status, 200);
                const before = await pool.query(
                    "SELECT submission_id, version, report_content FROM compliance_report_submissions WHERE report_id = $1 ORDER BY version",
                    [reportIds.revision]
                );
                const original = before.rows[0];
                const update = await request("manager", "PUT", `/api/compliance-reports/${reportIds.revision}`, {
                    report_content: reportContent("revised submission"),
                });
                assert.equal(update.status, 200);
                const resubmission = await submit(reportIds.revision);
                assert.equal(resubmission.status, 200);
                assert.equal(resubmission.payload.data.submission.version, 2);
                const submissions = await pool.query(
                    `SELECT submission_id, version, report_content, submitted_by_name, submitted_by_role
                     FROM compliance_report_submissions WHERE report_id = $1 ORDER BY version`,
                    [reportIds.revision]
                );
                assert.equal(submissions.rows.length, 2);
                assert.equal(submissions.rows[0].submission_id, original.submission_id);
                assert.deepEqual(submissions.rows[0].report_content, original.report_content);
                assert.equal(submissions.rows[0].submitted_by_name, actors.manager.name);
                assert.equal(submissions.rows[1].version, 2);
                assert.equal(submissions.rows[1].report_content.executive_summary, "revised submission executive summary with enough meaningful detail.");
                const staleDecision = await request("regulatorTwo", "POST", `/api/regulator/reports/${reportIds.revision}/review`, {
                    submission_id: firstSubmissionId,
                    decision: "ACCEPTED",
                });
                assert.equal(staleDecision.status, 409);
                assert.equal(staleDecision.payload.code, "STALE_SUBMISSION");
                assert.equal((await reportState(reportIds.revision)).rba_status, "SUBMITTED");
                const reviewsBefore = await pool.query(
                    "SELECT submission_id, decision, reason FROM compliance_report_reviews WHERE report_id = $1",
                    [reportIds.revision]
                );
                assert.equal(reviewsBefore.rows.length, 1);
                assert.equal(reviewsBefore.rows[0].submission_id, original.submission_id);
                const currentId = submissions.rows[1].submission_id;
                const decision = await request("regulatorTwo", "POST", `/api/regulator/reports/${reportIds.revision}/review`, {
                    submission_id: currentId,
                    decision: "ACCEPTED",
                });
                assert.equal(decision.status, 200);
                assert.equal(decision.payload.data.submission_version, 2);
                const reviewsAfter = await pool.query(
                    "SELECT submission_id, decision, reviewed_by_name FROM compliance_report_reviews WHERE report_id = $1 ORDER BY created_at",
                    [reportIds.revision]
                );
                assert.equal(reviewsAfter.rows.length, 2);
                assert.equal(reviewsAfter.rows[0].submission_id, original.submission_id);
                assert.equal(reviewsAfter.rows[0].decision, "REVISION_REQUESTED");
                assert.equal(reviewsAfter.rows[1].submission_id, submissions.rows[1].submission_id);
                assert.equal(reviewsAfter.rows[1].reviewed_by_name, actors.regulatorTwo.name);
            },
        },
        {
            name: "draft reports are hidden from regulators and cannot be reviewed",
            run: async () => {
                reportIds.draft = await createDraft("draft visibility");
                const detail = await request("regulatorOne", "GET", `/api/regulator/reports/${reportIds.draft}`);
                assert.equal(detail.status, 404);
                const decision = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.draft}/review`, {
                    decision: "ACCEPTED",
                });
                assert.equal(decision.status, 404);
                assert.equal((await reportState(reportIds.draft)).rba_status, "DRAFT");
            },
        },
        {
            name: "worker, manager-as-regulator, and inactive actors are rejected",
            run: async () => {
                const workerAttempt = await submit(reportIds.draft, "worker");
                assert.equal(workerAttempt.status, 403);
                const managerReview = await request("manager", "POST", `/api/regulator/reports/${reportIds.accept}/review`, {
                    submission_id: await currentSubmissionId(reportIds.accept),
                    decision: "ACCEPTED",
                });
                assert.equal(managerReview.status, 403);
                reportIds.inactiveManager = await createDraft("inactive manager");
                const inactiveSubmission = await submit(reportIds.inactiveManager, "inactiveManager");
                assert.equal(inactiveSubmission.status, 403);
                reportIds.inactiveRegulator = await createSubmitted("inactive regulator");
                const inactiveReview = await request("inactiveRegulator", "POST", `/api/regulator/reports/${reportIds.inactiveRegulator}/review`, {
                    submission_id: await currentSubmissionId(reportIds.inactiveRegulator),
                    decision: "ACCEPTED",
                });
                assert.equal(inactiveReview.status, 403);
                assert.equal((await reportState(reportIds.inactiveRegulator)).rba_status, "SUBMITTED");
            },
        },
        {
            name: "concurrent decisions use separate PostgreSQL sessions and commit exactly once",
            run: async () => {
                reportIds.concurrent = await createSubmitted("concurrency");
                const submissionId = await currentSubmissionId(reportIds.concurrent);
                const firstPid = pool.integrationBackendPids.length;
                const outcomes = await Promise.all([
                    request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.concurrent}/review`, {
                        submission_id: submissionId,
                        decision: "ACCEPTED",
                    }),
                    request("regulatorTwo", "POST", `/api/regulator/reports/${reportIds.concurrent}/review`, {
                        submission_id: submissionId,
                        decision: "REJECTED",
                        reason: "The evidence requires correction.",
                    }),
                ]);
                const pids = [...new Set(pool.integrationBackendPids.slice(firstPid))];
                assert.ok(pids.length >= 2, `Concurrent requests did not use separate PostgreSQL sessions: ${JSON.stringify(pids)}`);
                console.log(`CONCURRENCY_BACKEND_PIDS ${JSON.stringify(pids)}`);
                assert.deepEqual(outcomes.map((item) => item.status).sort((a, b) => a - b), [200, 409]);
                const { rows } = await pool.query(
                    "SELECT decision FROM compliance_report_reviews WHERE report_id = $1",
                    [reportIds.concurrent]
                );
                assert.equal(rows.length, 1);
                assert.equal((await reportState(reportIds.concurrent)).rba_status, rows[0].decision);
            },
        },
        {
            name: "submission and review failures roll back all transaction writes",
            run: async () => {
                reportIds.rollbackSubmit = await createDraft("rollback submission");
                reportIds.rollbackReview = await createSubmitted("rollback review");
                const beforeSubmit = await workflowCounts(reportIds.rollbackSubmit);
                const beforeReview = await workflowCounts(reportIds.rollbackReview);
                await pool.query(
                    `INSERT INTO public.compliance_api_integration_failure_targets (report_id)
                     VALUES ($1), ($2)`,
                    [reportIds.rollbackSubmit, reportIds.rollbackReview]
                );
                const submission = await submit(reportIds.rollbackSubmit);
                assert.equal(submission.status, 500);
                const afterSubmit = await workflowCounts(reportIds.rollbackSubmit);
                assert.equal(afterSubmit.status, "DRAFT");
                assert.equal(afterSubmit.submissions, beforeSubmit.submissions);
                assert.equal(afterSubmit.reviews, beforeSubmit.reviews);
                assert.equal(afterSubmit.audits.SUBMIT || 0, beforeSubmit.audits.SUBMIT || 0);
                assert.equal(afterSubmit.notifications, beforeSubmit.notifications);

                const review = await request("regulatorOne", "POST", `/api/regulator/reports/${reportIds.rollbackReview}/review`, {
                    submission_id: await currentSubmissionId(reportIds.rollbackReview),
                    decision: "ACCEPTED",
                });
                assert.equal(review.status, 500);
                const afterReview = await workflowCounts(reportIds.rollbackReview);
                assert.equal(afterReview.status, "SUBMITTED");
                assert.equal(afterReview.submissions, beforeReview.submissions);
                assert.equal(afterReview.reviews, beforeReview.reviews);
                assert.equal(afterReview.audits.APPROVE || 0, beforeReview.audits.APPROVE || 0);
                assert.equal(afterReview.notifications, beforeReview.notifications);
                console.log(`ROLLBACK_EVIDENCE ${JSON.stringify({
                    submission: { before: beforeSubmit, after: afterSubmit },
                    review: { before: beforeReview, after: afterReview },
                })}`);
            },
        },
        {
            name: "detail reads do not trigger concurrent-query warnings on a checked-out client",
            run: async () => {
                await request("manager", "GET", `/api/compliance-reports/${reportIds.accept}`);
                await request("regulatorOne", "GET", `/api/regulator/reports/${reportIds.accept}`);
                await new Promise((resolve) => setImmediate(resolve));
                assert.deepEqual(warnings, []);
            },
        },
    ];

    pool.integrationBackendPids = [];
    const originalConnect = pool.connect.bind(pool);
    pool.connect = (...args) => {
        const connection = originalConnect(...args);
        if (connection && typeof connection.then === "function") {
            return connection.then((client) => {
                pool.integrationBackendPids.push(client.processID);
                return client;
            });
        }
        return connection;
    };

    try {
        await runTests(tests);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        httpServer = null;
        await pool.end();
        integrationPool = null;
    }

    console.log(`TESTS ${tests.length}`);
    console.log(`PASS ${tests.length - failures.length}`);
    console.log(`FAIL ${failures.length}`);
    if (failures.length) {
        console.error(`FAILURES ${JSON.stringify(failures)}`);
        process.exitCode = 1;
    }
}

main().catch((error) => {
    console.error(`INTEGRATION_ABORTED ${error.stack || error.message}`);
    Promise.all([
        httpServer?.listening
            ? new Promise((resolve) => httpServer.close(resolve))
            : Promise.resolve(),
        integrationPool ? integrationPool.end() : Promise.resolve(),
    ]).finally(() => {
        process.exitCode = 1;
    });
});
