const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const DEMO_MARKER = "MICO-DEMO-PRESENTATION-2026-v1";
const DEMO_FUND_NAME = `${DEMO_MARKER} | Local presentation fund`;
const REQUIRED_ROLES = [
    { key: "worker", label: "Worker", role: "WORKER" },
    { key: "manager", label: "Fund Manager", role: "FUND_MANAGER" },
    { key: "regulator", label: "RBA Regulator", role: "REGULATOR" },
];
const REPORT_SCENARIOS = [
    { key: "accepted", decision: "ACCEPTED", expectedStatus: "ACCEPTED" },
    { key: "rejected", decision: "REJECTED", expectedStatus: "REJECTED" },
    { key: "revision", decision: "REVISION_REQUESTED", expectedStatus: "REVISION_REQUESTED" },
    { key: "resubmitted", decision: "REVISION_REQUESTED", expectedStatus: "SUBMITTED" },
];

function fail(message) {
    throw new Error(message);
}

function parseArguments(argv) {
    const options = {
        apiUrl: "http://127.0.0.1:5000",
        backupDir: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--api-url" || argument === "--backup-dir") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) fail(`Missing value for ${argument}.`);
            options[argument === "--api-url" ? "apiUrl" : "backupDir"] = value;
            index += 1;
        } else {
            fail(`Unknown option: ${argument}`);
        }
    }
    if (!options.backupDir || !path.isAbsolute(options.backupDir)) {
        fail("Provide --backup-dir as an absolute directory outside the repository.");
    }

    const backupDir = path.resolve(options.backupDir);
    const relative = path.relative(REPO_ROOT, backupDir);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
        fail("The backup directory must be outside the repository.");
    }

    let apiUrl;
    try {
        apiUrl = new URL(options.apiUrl);
    } catch {
        fail("--api-url must be a local HTTP URL.");
    }
    if (
        apiUrl.protocol !== "http:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(apiUrl.hostname) ||
        apiUrl.username ||
        apiUrl.password ||
        apiUrl.search ||
        apiUrl.hash ||
        (apiUrl.pathname !== "/" && apiUrl.pathname !== "")
    ) {
        fail("--api-url must be a local HTTP URL without credentials or a path.");
    }

    return { apiBase: apiUrl.origin, backupDir };
}

function askLine(question) {
    return new Promise((resolve, reject) => {
        const readline = require("node:readline");
        const input = readline.createInterface({ input: process.stdin, output: process.stdout });
        input.question(question, (answer) => {
            input.close();
            resolve(answer.trim());
        });
        input.on("SIGINT", () => {
            input.close();
            reject(new Error("Cancelled by user."));
        });
    });
}

function askSecret(question) {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        return Promise.reject(new Error("Secure password entry requires an interactive terminal."));
    }

    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    return new Promise((resolve, reject) => {
        let value = "";
        const cleanup = () => {
            process.stdin.removeListener("data", onData);
            process.stdin.setRawMode(false);
            process.stdout.write("\n");
        };
        const onData = (chunk) => {
            for (const character of chunk.toString("utf8")) {
                if (character === "\u0003") {
                    cleanup();
                    reject(new Error("Cancelled by user."));
                    return;
                }
                if (character === "\r" || character === "\n") {
                    cleanup();
                    resolve(value);
                    return;
                }
                if (character === "\u007f" || character === "\b") {
                    value = value.slice(0, -1);
                } else {
                    value += character;
                }
            }
        };
        process.stdin.on("data", onData);
    });
}

function safeErrorDetails(response, body) {
    const code = typeof body?.code === "string" && /^[A-Z0-9_]{1,60}$/.test(body.code)
        ? ` (${body.code})`
        : "";
    return `HTTP ${response.status}${code}`;
}

async function apiRequest(apiBase, token, endpoint, { method = "GET", body } = {}) {
    let response;
    try {
        response = await fetch(`${apiBase}${endpoint}`, {
            method,
            headers: {
                Accept: "application/json",
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body ? { "Content-Type": "application/json" } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            redirect: "error",
            signal: AbortSignal.timeout(30000),
        });
    } catch {
        fail(`Local API request failed: ${method} ${endpoint}. Confirm the development API is running.`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        fail(`Local API returned an invalid response: ${method} ${endpoint} (HTTP ${response.status}).`);
    }
    if (!response.ok || payload?.status === "error") {
        fail(`Local API rejected ${method} ${endpoint}: ${safeErrorDetails(response, payload)}.`);
    }
    return payload?.data;
}

async function login(apiBase, role) {
    console.log(`\nSign in to the existing ${role.label} account.`);
    const identifier = await askLine("Phone number or verified email: ");
    if (!identifier) fail(`${role.label} login identifier is required.`);
    let password = await askSecret("Password (hidden): ");
    if (!password) fail(`${role.label} password is required.`);

    let data;
    try {
        data = await apiRequest(apiBase, null, "/api/auth/login", {
            method: "POST",
            body: { identifier, password },
        });
    } finally {
        password = "";
    }
    if (!data?.token || data.user?.role !== role.role || !data.user?.user_id) {
        fail(`The signed-in account is not an authorized ${role.label} account.`);
    }
    if (data.user.force_password_change) {
        fail(`The ${role.label} account must complete its required password change in the application first.`);
    }
    console.log(`${role.label} authentication confirmed.`);
    return { token: data.token, user: data.user };
}

function childEnvironment() {
    const environment = {};
    for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        if (process.env[key]) environment[key] = process.env[key];
    }
    return environment;
}

function runPostgresCommand(command, args, { captureOutput = false } = {}) {
    const result = spawnSync(command, args, {
        env: childEnvironment(),
        encoding: "utf8",
        stdio: captureOutput ? ["inherit", "pipe", "inherit"] : "inherit",
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: false,
    });
    if (result.error) {
        fail(`Could not run ${command}. Install PostgreSQL command-line tools and ensure they are on PATH.`);
    }
    if (result.status !== 0) fail(`${command} failed with exit code ${result.status ?? "unknown"}.`);
    return result.stdout || "";
}

function parsePort(value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("PostgreSQL port must be between 1 and 65535.");
    return port;
}

function buildIdentityQuery(accounts) {
    const ids = Object.fromEntries(accounts.map(({ key, user }) => [`${key}_id`, user.user_id]));
    for (const id of Object.values(ids)) {
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
            fail("An authenticated account returned an unsupported user identifier.");
        }
    }
    return {
        variables: ids,
        sql: `SELECT json_build_object(
            'database', current_database(),
            'user', current_user,
            'server_address', inet_server_addr()::text,
            'server_port', inet_server_port(),
            'data_directory', current_setting('data_directory'),
            'accounts', (
                SELECT json_agg(json_build_object(
                    'user_id', user_id,
                    'role', role,
                    'account_status', account_status
                ) ORDER BY role)
                FROM users
                WHERE user_id IN (:'worker_id', :'manager_id', :'regulator_id')
            )
        )::text;`,
    };
}

function psqlBaseArgs({ database, dbUser, dbPort }) {
    return [
        "--no-psqlrc",
        "--password",
        "--host=127.0.0.1",
        `--port=${dbPort}`,
        `--username=${dbUser}`,
        `--dbname=${database}`,
    ];
}

function verifyDatabaseTarget(accounts, { database, dbUser, dbPort }) {
    const { variables, sql } = buildIdentityQuery(accounts);
    const args = [
        ...psqlBaseArgs({ database, dbUser, dbPort }),
        "--no-align",
        "--tuples-only",
        "--quiet",
        "--set=ON_ERROR_STOP=1",
        ...Object.entries(variables).map(([key, value]) => `--set=${key}=${value}`),
        `--command=${sql}`,
    ];
    const output = runPostgresCommand("psql", args, { captureOutput: true }).trim();
    let identity;
    try {
        identity = JSON.parse(output);
    } catch {
        fail("The selected PostgreSQL target did not return a valid identity record.");
    }

    if (
        identity.database !== database ||
        identity.user !== dbUser ||
        !["127.0.0.1", "::1"].includes(identity.server_address) ||
        Number(identity.server_port) !== dbPort ||
        !/^[A-Za-z]:[\\/]/.test(identity.data_directory)
    ) {
        fail("The selected database is not the confirmed local Windows development database. No application data was written.");
    }
    const rows = Array.isArray(identity.accounts) ? identity.accounts : [];
    for (const role of REQUIRED_ROLES) {
        const authenticated = accounts.find((account) => account.key === role.key);
        const row = rows.find((account) => account.user_id === authenticated.user.user_id);
        if (!row || row.role !== role.role || row.account_status !== "ACTIVE") {
            fail("The selected database does not contain the authenticated active role accounts. No application data was written.");
        }
    }
    return identity;
}

function ensureBackupDirectory(backupDir) {
    fs.mkdirSync(backupDir, { recursive: true });
    if (!fs.statSync(backupDir).isDirectory()) fail("The backup destination is not a directory.");
}

async function hashFile(filePath) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    return hash.digest("hex");
}

async function createAndVerifyBackup(database, dbUser, dbPort, backupDir) {
    ensureBackupDirectory(backupDir);
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
    const suffix = crypto.randomUUID();
    const safeDatabase = database.replace(/[^A-Za-z0-9_-]/g, "_");
    const backupPath = path.join(backupDir, `micopesa-demo-${safeDatabase}-${timestamp}-${suffix}.dump`);
    if (fs.existsSync(backupPath)) fail("The generated backup filename already exists; refusing to overwrite it.");

    try {
        runPostgresCommand("pg_dump", [
            "--format=custom",
            "--host=127.0.0.1",
            `--port=${dbPort}`,
            `--username=${dbUser}`,
            `--dbname=${database}`,
            "--password",
            `--file=${backupPath}`,
        ]);
        if (!fs.statSync(backupPath).isFile() || fs.statSync(backupPath).size === 0) {
            fail("pg_dump did not create a non-empty backup.");
        }
        const listing = runPostgresCommand("pg_restore", ["--list", backupPath], { captureOutput: true });
        if (!listing.includes("Dumped from database version") || !listing.includes("TABLE DATA")) {
            fail("The backup archive did not pass its restore-list verification.");
        }
        const hash = await hashFile(backupPath);
        return { backupPath, size: fs.statSync(backupPath).size, sha256: hash };
    } catch (error) {
        if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
        throw error;
    }
}

function isForbiddenDatabaseName(database) {
    return /(test|rehearsal|recovery)/i.test(database) ||
        database.toLowerCase() === "micopesa_test";
}

function lastCompletedQuarter(now = new Date()) {
    const currentQuarter = Math.floor(now.getUTCMonth() / 3);
    const end = new Date(Date.UTC(now.getUTCFullYear(), currentQuarter * 3, 0));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
    return {
        period_start: start.toISOString().slice(0, 10),
        period_end: end.toISOString().slice(0, 10),
    };
}

function reportContent(scenario, revised = false) {
    const marker = `${DEMO_MARKER}-${scenario.key.toUpperCase()}`;
    const revision = revised
        ? " This resubmitted version responds to the regulator's earlier request for clearer supporting detail."
        : "";
    return {
        executive_summary:
            `${marker}. Synthetic demonstration report only; it is not a real fund statement or regulatory filing.${revision}`,
        financial_summary:
            "Illustrative figures are used solely to demonstrate the report workflow. No real worker balance, contribution, return, transaction, or settlement is represented.",
        risk_and_governance:
            "This synthetic example records a quarterly governance review, assigns oversight to the existing fund manager, and describes a sample risk review without asserting a real investment result.",
        incidents_and_actions:
            "No real incident is represented. This demonstration section shows where an incident description, responsible officer, corrective action, and target date would be recorded.",
        supporting_information:
            "All names, figures, and narrative in this report are demonstration material. Verify actual source documents through the normal application before any real regulatory decision.",
    };
}

async function getManagerReport(apiBase, token, reportId) {
    return apiRequest(apiBase, token, `/api/compliance-reports/${encodeURIComponent(reportId)}`);
}

async function listDemoReports(apiBase, manager) {
    const summaries = await apiRequest(apiBase, manager.token, "/api/compliance-reports/");
    if (!Array.isArray(summaries)) fail("Manager report listing returned an unexpected response.");
    const reports = [];
    for (let offset = 0; offset < summaries.length; offset += 8) {
        const batch = await Promise.all(summaries.slice(offset, offset + 8).map((summary) =>
            getManagerReport(apiBase, manager.token, summary.report_id)
        ));
        reports.push(...batch);
    }
    const tagged = reports.filter((details) =>
        Object.values(details?.report?.report_content || {}).some((section) =>
            typeof section === "string" && section.includes(`${DEMO_MARKER}-`)
        )
    );
    const byScenario = new Map();
    for (const details of tagged) {
        const summary = details.report.report_content.executive_summary || "";
        const scenario = REPORT_SCENARIOS.find(({ key }) =>
            summary.includes(`${DEMO_MARKER}-${key.toUpperCase()}`)
        );
        if (!scenario) continue;
        if (details.report.generated_by !== manager.user.user_id) {
            fail("A demo marker belongs to a different manager; refusing to modify it.");
        }
        if (byScenario.has(scenario.key)) {
            fail(`Duplicate ${scenario.key} demo reports exist. Review them manually; no records were changed.`);
        }
        byScenario.set(scenario.key, details);
    }
    return byScenario;
}

async function selectFund(apiBase, manager) {
    const funds = await apiRequest(apiBase, manager.token, "/api/funds");
    if (!Array.isArray(funds)) fail("Fund listing returned an unexpected response.");
    const marked = funds.find((fund) => fund.fund_name === DEMO_FUND_NAME);
    if (marked && marked.fund_status !== "ACTIVE") {
        fail("The existing DEMO fund is not active. It was left unchanged; resolve it manually before rerunning.");
    }
    const existing = marked || funds.find((fund) => fund.fund_status === "ACTIVE");
    if (existing) return { fund: existing, created: false };
    return { fund: null, created: true };
}

async function createDemoFund(apiBase, manager) {
    const data = await apiRequest(apiBase, manager.token, "/api/funds", {
        method: "POST",
        body: {
            fund_name: DEMO_FUND_NAME,
            administrator_name: `${DEMO_MARKER} Administrator`,
            risk_level: "LOW",
            expected_return: 5,
        },
    });
    if (!data?.fund?.fund_id || data.fund.fund_status !== "ACTIVE" || data.fund.fund_name !== DEMO_FUND_NAME) {
        fail("The application did not confirm the expected active DEMO fund.");
    }
    const verified = await apiRequest(
        apiBase,
        manager.token,
        `/api/funds/${encodeURIComponent(data.fund.fund_id)}`
    );
    if (
        verified?.fund?.fund_id !== data.fund.fund_id ||
        verified.fund.fund_name !== DEMO_FUND_NAME ||
        verified.fund.fund_status !== "ACTIVE"
    ) {
        fail("The DEMO fund could not be verified through the manager API.");
    }
    return { fund: verified.fund, created: true };
}

function amountInCents(value) {
    const text = String(value ?? "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

function deterministicContributionAmount(workerId) {
    const digest = crypto.createHash("sha256").update(`${DEMO_MARKER}:${workerId}`).digest();
    const cents = 25000 + (digest.readUInt32BE(0) % 10000);
    return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

function sameFundSet(actual, expected) {
    if (!Array.isArray(actual)) return false;
    const actualIds = actual.map((item) => item.fund_id).sort();
    const expectedIds = [...expected].sort();
    return actualIds.length === expectedIds.length &&
        actualIds.every((fundId, index) => fundId === expectedIds[index]);
}

async function ensurePendingContribution(apiBase, worker) {
    const [allocations, contributions] = await Promise.all([
        apiRequest(apiBase, worker.token, "/api/funds/my-allocations"),
        apiRequest(apiBase, worker.token, "/api/accounts/my-contributions"),
    ]);
    if (!Array.isArray(allocations) || !Array.isArray(contributions)) {
        fail("Worker allocation or contribution history returned an unexpected response.");
    }
    if (allocations.length === 0) {
        return { skipped: "No current worker fund allocation exists; the runner will not change allocation preferences." };
    }

    const fundIds = allocations.map((allocation) => allocation.fund_id);
    const amount = deterministicContributionAmount(worker.user.user_id);
    const matching = contributions.find((contribution) =>
        amountInCents(contribution.amount) === amountInCents(amount) &&
        contribution.channel === "BANK" &&
        sameFundSet(contribution.fund_allocations, fundIds)
    );
    if (matching) {
        if (matching.contribution_status !== "PENDING" || matching.transaction_status !== "PENDING") {
            return {
                skipped: "A matching contribution already exists in a non-pending state; it was not changed or duplicated.",
            };
        }
        return {
            contribution: matching,
            created: false,
            note: "A matching BANK contribution already exists; it was not changed.",
        };
    }

    return { amount, fundIds, created: null };
}

async function getRetirementPlan(apiBase, worker) {
    const data = await apiRequest(apiBase, worker.token, "/api/retirement/my-plan");
    if (!data || !Object.hasOwn(data, "plan")) fail("Retirement plan endpoint returned an unexpected response.");
    return data;
}

async function askPositiveNumber(label, defaultValue, maximum) {
    const text = await askLine(`${label} [${defaultValue}]: `);
    const value = text === "" ? defaultValue : Number(text);
    if (!Number.isFinite(value) || value <= 0 || value > maximum) {
        fail(`${label} must be a positive number no greater than ${maximum}.`);
    }
    return value;
}

async function collectRetirementScenario(apiBase, worker, planData) {
    if (planData.plan) return { planData, scenario: null, reused: true };
    console.log("\nNo active plan exists. A plan can be created through the worker API; existing plans will never be updated.");
    const currentAge = await askPositiveNumber("Worker's current age for this planning scenario", 35, 100);
    const targetAge = await askPositiveNumber("Target retirement age", 65, 100);
    if (targetAge <= currentAge) fail("Target retirement age must be greater than current age.");
    const targetAmount = await askPositiveNumber("Target retirement savings (KES)", 2500000, 999999999);
    const monthlyContribution = await askPositiveNumber("Planned monthly contribution (KES)", 3000, 999999999);
    return {
        planData,
        scenario: {
            current_age: currentAge,
            target_retirement_age: targetAge,
            target_amount: targetAmount,
            monthly_contribution_target: monthlyContribution,
        },
        reused: false,
    };
}

async function createDraft(apiBase, manager, fundId, scenario) {
    const period = lastCompletedQuarter();
    const data = await apiRequest(apiBase, manager.token, "/api/compliance-reports/", {
        method: "POST",
        body: {
            fund_id: fundId,
            report_type: "RBA",
            ...period,
            report_content: reportContent(scenario),
        },
    });
    if (!data?.report?.report_id || data.report.rba_status !== "DRAFT") {
        fail(`The application did not confirm creation of the ${scenario.key} report draft.`);
    }
    return getManagerReport(apiBase, manager.token, data.report.report_id);
}

async function submitReport(apiBase, manager, details) {
    await apiRequest(apiBase, manager.token, `/api/compliance-reports/${encodeURIComponent(details.report.report_id)}/submit`, {
        method: "POST",
    });
    return getManagerReport(apiBase, manager.token, details.report.report_id);
}

async function requestDecision(apiBase, regulator, details, decision) {
    if (details.report.rba_status !== "SUBMITTED") {
        fail(`Report ${details.report.report_id} is not submitted; no decision was recorded.`);
    }
    const latestSubmission = details.submissions?.at(-1);
    if (!latestSubmission?.submission_id) {
        fail(`Report ${details.report.report_id} has no current submission ID.`);
    }
    const reason = decision === "ACCEPTED"
        ? undefined
        : decision === "REJECTED"
            ? "DEMO review: sample report is rejected to demonstrate the decision workflow."
            : "DEMO review: add clearer supporting detail before resubmission.";
    await apiRequest(apiBase, regulator.token, `/api/regulator/reports/${encodeURIComponent(details.report.report_id)}/review`, {
        method: "POST",
        body: {
            decision,
            submission_id: latestSubmission.submission_id,
            ...(reason ? { reason } : {}),
        },
    });
}

async function reviseAndResubmit(apiBase, manager, details, scenario) {
    const revisedContent = reportContent(scenario, true);
    await apiRequest(apiBase, manager.token, `/api/compliance-reports/${encodeURIComponent(details.report.report_id)}`, {
        method: "PUT",
        body: { report_content: revisedContent },
    });
    return submitReport(apiBase, manager, details);
}

async function ensureReportScenario(apiBase, manager, regulator, fundId, known, scenario) {
    let details = known.get(scenario.key) || await createDraft(apiBase, manager, fundId, scenario);

    if (
        scenario.key === "revision" &&
        details.reviews?.some((review) => review.decision === "REVISION_REQUESTED")
    ) {
        return details;
    }

    if (scenario.key === "resubmitted") {
        const hasRevisionDecision = details.reviews?.some((review) => review.decision === "REVISION_REQUESTED");
        if (hasRevisionDecision && (details.submissions?.length || 0) >= 2) return details;
        if (details.report.rba_status === "DRAFT") {
            details = await submitReport(apiBase, manager, details);
        }
        if (details.report.rba_status === "SUBMITTED" && !hasRevisionDecision) {
            await requestDecision(apiBase, regulator, details, "REVISION_REQUESTED");
            details = await getManagerReport(apiBase, manager.token, details.report.report_id);
        }
        if (details.report.rba_status === "REVISION_REQUESTED") {
            details = await reviseAndResubmit(apiBase, manager, details, scenario);
        }
        if (
            details.report.rba_status !== "SUBMITTED" &&
            !["ACCEPTED", "REJECTED"].includes(details.report.rba_status)
        ) {
            fail(`Resubmission scenario ended in unexpected status ${details.report.rba_status}.`);
        }
        if (!details.reviews?.some((review) => review.decision === "REVISION_REQUESTED") ||
            (details.report.rba_status === "SUBMITTED" && (details.submissions?.length || 0) < 2)) {
            fail("The resubmission report does not contain verified revision and resubmission history.");
        }
        return details;
    }

    if (details.report.rba_status === "DRAFT") details = await submitReport(apiBase, manager, details);
    if (details.report.rba_status === "SUBMITTED") {
        await requestDecision(apiBase, regulator, details, scenario.decision);
        details = await getManagerReport(apiBase, manager.token, details.report.report_id);
    } else if (details.report.rba_status === "REVISION_REQUESTED" && scenario.expectedStatus !== "REVISION_REQUESTED") {
        details = await reviseAndResubmit(apiBase, manager, details, scenario);
        await requestDecision(apiBase, regulator, details, scenario.decision);
        details = await getManagerReport(apiBase, manager.token, details.report.report_id);
    }

    if (details.report.rba_status !== scenario.expectedStatus) {
        fail(`${scenario.key} report ended in ${details.report.rba_status}; expected ${scenario.expectedStatus}.`);
    }
    const latestReview = details.reviews?.at(-1);
    if (latestReview?.decision !== scenario.decision) {
        fail(`${scenario.key} report is missing its expected regulator decision history.`);
    }
    return details;
}

async function verifyReport(apiBase, manager, regulator, details, scenario) {
    const managerView = await getManagerReport(apiBase, manager.token, details.report.report_id);
    const regulatorView = await apiRequest(
        apiBase,
        regulator.token,
        `/api/regulator/reports/${encodeURIComponent(details.report.report_id)}`
    );
    const statusIsExpected = managerView.report.rba_status === scenario.expectedStatus &&
        regulatorView.report.rba_status === scenario.expectedStatus;
    const revisionHistory = (managerView.reviews || []).some((review) => review.decision === "REVISION_REQUESTED");
    const laterWorkflowStatus = ["SUBMITTED", "REVISION_REQUESTED", "ACCEPTED", "REJECTED"]
        .includes(managerView.report.rba_status);
    const resubmissionHistory = (managerView.submissions || []).length >= 2 && revisionHistory;
    if (
        (!statusIsExpected &&
            !(scenario.key === "revision" && revisionHistory && laterWorkflowStatus) &&
            !(scenario.key === "resubmitted" && resubmissionHistory && laterWorkflowStatus)) ||
        regulatorView.report.report_id !== details.report.report_id ||
        regulatorView.report.rba_status !== managerView.report.rba_status
    ) {
        fail(`Could not verify the final ${scenario.key} report through both application roles.`);
    }
    const managerSubmissions = managerView.submissions || [];
    const managerReviews = managerView.reviews || [];
    if (!managerSubmissions.length || !managerReviews.length) {
        fail(`The ${scenario.key} report is missing submission or review history.`);
    }
    if (
        managerView.report.generated_by !== manager.user.user_id ||
        managerSubmissions.some((submission) =>
            submission.submitted_by !== manager.user.user_id ||
            submission.submitted_by_role !== "FUND_MANAGER"
        ) ||
        managerReviews.some((review) =>
            review.reviewed_by !== regulator.user.user_id ||
            review.reviewer_role !== "REGULATOR"
        )
    ) {
        fail(`The ${scenario.key} report history contains an unexpected actor identity.`);
    }
    if (scenario.key === "resubmitted" && !resubmissionHistory) {
        fail("The resubmitted report does not retain at least two submission versions.");
    }
    if (scenario.key === "revision" && !managerReviews.some((review) => review.decision === "REVISION_REQUESTED")) {
        fail("The revision scenario is missing its regulator revision-request history.");
    }
    return managerView;
}

async function prepareWorkerActivity(apiBase, worker, retirement) {
    let planData = retirement.planData;
    let retirementPlanCreated = false;
    if (retirement.scenario) {
        const fresh = await getRetirementPlan(apiBase, worker);
        if (fresh.plan) {
            planData = fresh;
        } else {
            const created = await apiRequest(apiBase, worker.token, "/api/retirement/my-plan", {
                method: "POST",
                body: retirement.scenario,
            });
            planData = await getRetirementPlan(apiBase, worker);
            if (!created?.plan?.plan_id || !planData.plan || planData.plan.plan_id !== created.plan.plan_id) {
                fail("The application did not confirm the newly created retirement plan.");
            }
            retirementPlanCreated = true;
        }
    }

    const contribution = await ensurePendingContribution(apiBase, worker);
    let contributionResult = contribution;
    if (contribution.created === null) {
        const created = await apiRequest(apiBase, worker.token, "/api/accounts/my-contributions", {
            method: "POST",
            body: { amount: contribution.amount, channel: "BANK", fund_ids: contribution.fundIds },
        });
        const record = created?.contribution;
        const transaction = created?.transaction;
        if (
            created?.payment_status !== "PENDING" ||
            record?.contribution_status !== "PENDING" ||
            transaction?.transaction_status !== "PENDING" ||
            !record?.contribution_id
        ) {
            fail("The contribution API did not confirm a pending, unsettled contribution. Stop and inspect the record manually.");
        }
        const history = await apiRequest(apiBase, worker.token, "/api/accounts/my-contributions");
        const verified = history.find((item) => item.contribution_id === record.contribution_id);
        if (
            !verified ||
            verified.contribution_status !== "PENDING" ||
            verified.transaction_status !== "PENDING" ||
            !sameFundSet(verified.fund_allocations, contribution.fundIds)
        ) {
            fail("The pending contribution could not be verified in worker history. Stop and inspect the record manually.");
        }
        contributionResult = { contribution: verified, created: true };
    }
    return { planData, retirementPlanCreated, contribution: contributionResult };
}

async function main() {
    const { apiBase, backupDir } = parseArguments(process.argv.slice(2));
    console.log("MicoPesa local demo preparation");
    console.log("It creates application records only through authenticated APIs; PostgreSQL tools are used only for target verification and backup.");
    console.log("It does not create users, send external messages, call M-Pesa, or settle payments.");

    const accounts = [];
    for (const role of REQUIRED_ROLES) {
        const authenticated = await login(apiBase, role);
        accounts.push({ ...role, ...authenticated });
    }
    if (new Set(accounts.map(({ user }) => user.user_id)).size !== accounts.length) {
        fail("Each role must authenticate with a distinct existing account.");
    }
    const manager = accounts.find(({ key }) => key === "manager");
    const regulator = accounts.find(({ key }) => key === "regulator");
    const worker = accounts.find(({ key }) => key === "worker");
    if (manager.user.user_id === regulator.user.user_id) fail("A report submitter cannot act as its regulator.");

    const database = await askLine("\nExact name of the existing Windows development database: ");
    if (!database || !/^[A-Za-z0-9_][A-Za-z0-9_-]{0,62}$/.test(database) || isForbiddenDatabaseName(database)) {
        fail("The database name is empty or identifies a test, rehearsal, or recovery database.");
    }
    const dbUser = await askLine("Existing PostgreSQL username: ");
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/.test(dbUser)) fail("Enter a valid PostgreSQL username.");
    const portText = await askLine("Windows PostgreSQL port [5432]: ");
    const dbPort = parsePort(portText || "5432");
    if (await askLine(`Type CONNECT ${database} to verify this local database target: `) !== `CONNECT ${database}`) {
        fail("Database target confirmation did not match.");
    }

    const identity = verifyDatabaseTarget(accounts, { database, dbUser, dbPort });
    console.log(`Verified local Windows PostgreSQL target: ${identity.database} on 127.0.0.1:${dbPort}.`);
    console.log("The authenticated Worker, Fund Manager, and Regulator accounts match this database.");
    console.log("PostgreSQL will prompt for its password without echoing it.");
    const backup = await createAndVerifyBackup(database, dbUser, dbPort, backupDir);
    console.log(`Verified fresh backup: ${backup.backupPath}`);
    console.log(`Backup size: ${backup.size} bytes; SHA-256: ${backup.sha256}`);

    const [retirementData, allocationData, contributionData, reports] = await Promise.all([
        getRetirementPlan(apiBase, worker),
        apiRequest(apiBase, worker.token, "/api/funds/my-allocations"),
        apiRequest(apiBase, worker.token, "/api/accounts/my-contributions"),
        listDemoReports(apiBase, manager),
    ]);
    if (!Array.isArray(allocationData) || !Array.isArray(contributionData)) {
        fail("A worker or fund API returned an unexpected response.");
    }
    await apiRequest(apiBase, regulator.token, "/api/regulator/compliance");

    const retirement = await collectRetirementScenario(apiBase, worker, retirementData);
    const fund = await selectFund(apiBase, manager);
    const pending = await ensurePendingContribution(apiBase, worker);
    const actions = [
        retirement.reused
            ? `Reuse existing retirement plan ${retirementData.plan.plan_id} without changes`
            : "Create a retirement plan only if the worker still has no active plan",
        fund.created
            ? `Create the clearly labelled DEMO fund ${DEMO_FUND_NAME}`
            : `Reuse existing active fund ${fund.fund.fund_name}`,
        pending.skipped
            ? `Skip pending contribution: ${pending.skipped}`
            : pending.created === false
                ? `Reuse matching pending contribution ${pending.contribution.contribution_id}`
                : `Create one BANK contribution of KES ${pending.amount} against current allocations; it remains PENDING`,
        ...REPORT_SCENARIOS.map((scenario) => reports.has(scenario.key)
            ? `Continue the existing ${scenario.key} report workflow`
            : `Create and process the ${scenario.key} report workflow`),
    ];

    console.log("\nPlanned operations after backup:");
    for (const action of actions) console.log(`- ${action}`);
    console.log("\nContribution records have no supported DEMO description field; the runner uses a stable amount/channel/allocation match for idempotency.");
    console.log("Do not use these accounts in parallel while the runner is executing.");
    if (await askLine("\nType CREATE DEMO RECORDS to continue: ") !== "CREATE DEMO RECORDS") {
        console.log("Cancelled. The verified backup remains available; no demo records were created.");
        return;
    }

    const workerResults = await prepareWorkerActivity(apiBase, worker, retirement);
    const fundResult = fund.created ? await createDemoFund(apiBase, manager) : fund;
    const reportsResult = [];
    for (const scenario of REPORT_SCENARIOS) {
        const details = await ensureReportScenario(apiBase, manager, regulator, fundResult.fund.fund_id, reports, scenario);
        reportsResult.push(await verifyReport(apiBase, manager, regulator, details, scenario));
    }

    console.log("\nDemo preparation verified.");
    const projection = workerResults.planData.projection;
    console.log(
        `Worker retirement plan: ${workerResults.planData.plan?.plan_id || "none"} ` +
        `(${workerResults.retirementPlanCreated ? "created" : "retained"}); projection: ${projection?.projection_id || "not available"}`
    );
    if (workerResults.contribution?.contribution) {
        const record = workerResults.contribution.contribution;
        console.log(`Contribution ${record.contribution_id}: ${record.contribution_status}, channel ${record.channel}, KES ${record.amount}`);
    } else if (workerResults.contribution?.skipped) {
        console.log(`Contribution: skipped (${workerResults.contribution.skipped})`);
    }
    console.log(`Fund ${fundResult.fund.fund_id}: ${fundResult.fund.fund_name} (${fundResult.fund.fund_status})`);
    for (const details of reportsResult) {
        const report = details.report;
        const submission = details.submissions.at(-1);
        console.log(`Report ${report.report_id}: ${report.rba_status}; latest submission ${submission.submission_id} (version ${submission.version})`);
        console.log(`  Review history: ${details.reviews.map((review) => review.decision).join(" -> ")}`);
    }
    console.log("No payment was initiated or settled. Compliance audit and in-app notification history was generated by the normal workflows.");
}

main().catch((error) => {
    console.error(`Demo preparation stopped: ${error.message}`);
    process.exitCode = 1;
});
