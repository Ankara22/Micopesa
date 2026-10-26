const { after, before, beforeEach, test } = require("node:test");
const assert = require("node:assert/strict");
const { isIP } = require("node:net");
const { Pool } = require("pg");

const TEST_DATABASE_NAME = "micopesa_test";
const REQUIRED_INDEX = "uq_withdrawal_claims_one_pending_per_account";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackAddress(address) {
    if (typeof address !== "string") return false;
    const normalized = address.toLowerCase().split("%")[0].split("/")[0];
    if (normalized === "::1") return true;
    if (normalized.startsWith("::ffff:")) return isLoopbackAddress(normalized.slice(7));
    return isIP(normalized) === 4 && normalized.startsWith("127.");
}

function validateTestDatabaseUrl(connectionString) {
    let parsed;
    try {
        parsed = new URL(connectionString);
    } catch {
        throw new Error("Withdrawal integration test requires a valid TEST_DATABASE_URL.");
    }

    let databaseName;
    try {
        databaseName = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
        databaseName = "";
    }

    const hostname = parsed.hostname.toLowerCase();
    const hostOverride = parsed.searchParams.get("host");
    const hostAddress = parsed.searchParams.get("hostaddr");
    const validHost = LOCAL_HOSTS.has(hostname);
    const validOverrides =
        (!parsed.searchParams.has("host") || (hostOverride && LOCAL_HOSTS.has(hostOverride.toLowerCase()))) &&
        (!parsed.searchParams.has("hostaddr") || (hostAddress && isLoopbackAddress(hostAddress))) &&
        !parsed.searchParams.has("service");

    if (!["postgres:", "postgresql:"].includes(parsed.protocol) ||
        databaseName !== TEST_DATABASE_NAME || !validHost || !validOverrides) {
        throw new Error("Withdrawal integration tests may connect only to local micopesa_test.");
    }
}

const connectionString = process.env.TEST_DATABASE_URL;
validateTestDatabaseUrl(connectionString);
process.env.DATABASE_URL = connectionString;

const verificationPool = new Pool({ connectionString, max: 1 });
const applicationPool = require("../src/db/database");
const withdrawalController = require("../src/controllers/withdrawalController");
const fundManagerController = require("../src/controllers/fundManagerController");

let verifiedTarget = false;
let preflightFailure = null;
let fixtureSequence = 0;

before(async () => {
    let client;
    try {
        client = await verificationPool.connect();
        const target = await client.query(
            `SELECT current_database() AS database_name,
                    inet_server_addr()::text AS server_address`
        );
        const row = target.rows[0];
        if (!row || row.database_name !== TEST_DATABASE_NAME || !isLoopbackAddress(row.server_address)) {
            throw new Error("Connected database is not the local micopesa_test target; no writes were made.");
        }

        const indexResult = await client.query(
            `SELECT i.indisunique AS is_unique,
                    i.indpred IS NOT NULL AS has_predicate,
                    pg_get_indexdef(i.indexrelid, 1, true) AS indexed_column,
                    pg_get_expr(i.indpred, i.indrelid) AS predicate
             FROM pg_index i
             JOIN pg_class idx ON idx.oid = i.indexrelid
             JOIN pg_namespace ns ON ns.oid = idx.relnamespace
             WHERE idx.relname = $1
               AND ns.nspname = current_schema()
               AND i.indrelid = 'withdrawal_claims'::regclass`,
            [REQUIRED_INDEX]
        );
        const index = indexResult.rows[0];
        const normalizedPredicate = index?.predicate
            ?.replace(/"/g, "")
            .replace(/[()]/g, "")
            .replace(/::(?:character varying|text)/gi, "")
            .replace(/\s+/g, "")
            .toLowerCase();
        if (!index) {
            preflightFailure = `Required partial unique index ${REQUIRED_INDEX} is absent. ` +
                "Apply database/migration_withdrawal_pending_unique.sql separately before running integration tests.";
            return;
        }
        if (!index.is_unique || !index.has_predicate ||
            index.indexed_column !== "account_id" ||
            normalizedPredicate !== "claim_status='pending'") {
            preflightFailure = `Index ${REQUIRED_INDEX} exists but does not match the required unique account_id WHERE claim_status = 'PENDING' definition. ` +
                "Review the schema and migration before running integration tests.";
            return;
        }
        verifiedTarget = true;
    } catch {
        preflightFailure = "Unable to verify the connected local test database and required index; no writes were made.";
    } finally {
        client?.release();
    }
});

beforeEach((context) => {
    if (preflightFailure) context.skip(preflightFailure);
});

after(async () => {
    await Promise.all([verificationPool.end(), applicationPool.end()]);
});

function createResponse() {
    return {
        statusCode: null,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
    };
}

async function createFixture(balance = 100) {
    assert.equal(verifiedTarget, true, "database target must be verified before fixture writes");
    const suffix = `${Date.now()}${++fixtureSequence}${Math.floor(Math.random() * 100000)}`.slice(-10);
    const client = await verificationPool.connect();
    try {
        await client.query("BEGIN");
        const workerResult = await client.query(
            `INSERT INTO users (full_name, phone, password_hash, role, occupation)
             VALUES ('Withdrawal Integration Worker', $1, 'integration-test-hash', 'WORKER', 'OTHER_INFORMAL_WORKER')
             RETURNING user_id`,
            [`254${suffix}`]
        );
        const managerResult = await client.query(
            `INSERT INTO users (full_name, phone, password_hash, role)
             VALUES ('Withdrawal Integration Manager', $1, 'integration-test-hash', 'FUND_MANAGER')
             RETURNING user_id`,
            [`255${suffix}`]
        );
        const accountResult = await client.query(
            `INSERT INTO pension_accounts (user_id, current_balance, retirement_age)
             VALUES ($1, $2, 60)
             RETURNING account_id`,
            [workerResult.rows[0].user_id, balance]
        );
        await client.query("COMMIT");
        return {
            workerId: workerResult.rows[0].user_id,
            managerId: managerResult.rows[0].user_id,
            accountId: accountResult.rows[0].account_id,
        };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function createClaim(fixture, { amount, status = "PENDING", reviewedBy = null } = {}) {
    const result = await verificationPool.query(
        `INSERT INTO withdrawal_claims
            (account_id, reviewed_by, amount_requested, destination_phone, withdrawal_reason, claim_status, reviewed_at)
         VALUES ($1, $2, $3, '254700000001', 'Integration test claim', $4,
                 CASE WHEN $2::varchar IS NULL THEN NULL ELSE now() END)
         RETURNING claim_id`,
        [fixture.accountId, reviewedBy, amount, status]
    );
    return result.rows[0].claim_id;
}

async function cleanupFixture(fixture) {
    if (!fixture || !verifiedTarget) return;
    const client = await verificationPool.connect();
    try {
        await client.query("BEGIN");
        const claims = await client.query(
            "SELECT claim_id FROM withdrawal_claims WHERE account_id = $1",
            [fixture.accountId]
        );
        const claimIds = claims.rows.map(({ claim_id }) => claim_id);
        if (claimIds.length) {
            await client.query(
                "DELETE FROM audit_logs WHERE entity_name = 'WITHDRAWAL_CLAIMS' AND entity_id = ANY($1::varchar[])",
                [claimIds]
            );
        }
        await client.query("DELETE FROM withdrawal_claims WHERE account_id = $1", [fixture.accountId]);
        await client.query("DELETE FROM pension_accounts WHERE account_id = $1", [fixture.accountId]);
        await client.query("DELETE FROM users WHERE user_id = ANY($1::varchar[])", [
            [fixture.workerId, fixture.managerId],
        ]);
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}

async function withFixture(run, balance = 100) {
    let fixture;
    try {
        fixture = await createFixture(balance);
        await run(fixture);
    } finally {
        await cleanupFixture(fixture);
    }
}

async function submit(fixture, amount) {
    const response = createResponse();
    await withdrawalController.submitClaim({
        user: { userId: fixture.workerId },
        body: {
            amount_requested: amount,
            destination_phone: "254700000001",
            withdrawal_reason: "Integration test request",
        },
    }, response);
    return response;
}

async function managerReview(fixture, claimId, decision) {
    const response = createResponse();
    await fundManagerController.reviewWithdrawal({
        user: { userId: fixture.managerId },
        params: { id: claimId },
        body: { decision },
    }, response);
    return response;
}

async function getClaim(claimId) {
    const result = await verificationPool.query(
        "SELECT claim_status, transaction_id, processed_at FROM withdrawal_claims WHERE claim_id = $1",
        [claimId]
    );
    return result.rows[0];
}

async function getBalance(accountId) {
    const result = await verificationPool.query(
        "SELECT current_balance FROM pension_accounts WHERE account_id = $1",
        [accountId]
    );
    return Number(result.rows[0].current_balance);
}

async function getAuditCount(claimId) {
    const result = await verificationPool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE entity_name = 'WITHDRAWAL_CLAIMS' AND entity_id = $1",
        [claimId]
    );
    return result.rows[0].count;
}

test("simultaneous submissions for one account create only one pending claim", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        const results = await Promise.all([submit(fixture, 60), submit(fixture, 60)]);
        assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [201, 409]);
        const count = await verificationPool.query(
            "SELECT count(*)::int AS count FROM withdrawal_claims WHERE account_id = $1 AND claim_status = 'PENDING'",
            [fixture.accountId]
        );
        assert.equal(count.rows[0].count, 1);
    });
});

test("approval respects aggregate approved-unpaid reservations for distinct claims", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        await createClaim(fixture, { amount: 70, status: "APPROVED", reviewedBy: fixture.managerId });
        const pendingClaimId = await createClaim(fixture, { amount: 40 });
        const result = await managerReview(fixture, pendingClaimId, "APPROVED");
        assert.equal(result.statusCode, 409);
        assert.equal((await getClaim(pendingClaimId)).claim_status, "PENDING");
    });
});

test("concurrent approvals of the same claim produce one decision and audit event", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        const claimId = await createClaim(fixture, { amount: 40 });
        const results = await Promise.all([
            managerReview(fixture, claimId, "APPROVED"),
            managerReview(fixture, claimId, "APPROVED"),
        ]);
        assert.deepEqual(results.map(({ statusCode }) => statusCode).sort(), [200, 409]);
        assert.equal((await getClaim(claimId)).claim_status, "APPROVED");
        assert.equal(await getAuditCount(claimId), 1);
    });
});

test("approved unpaid claims reduce available balance", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        await createClaim(fixture, { amount: 65, status: "APPROVED", reviewedBy: fixture.managerId });
        const eligibility = createResponse();
        await withdrawalController.checkEligibility({ user: { userId: fixture.workerId } }, eligibility);
        assert.equal(eligibility.statusCode, 200);
        assert.equal(eligibility.body.data.current_balance, "100.00");
        assert.equal(eligibility.body.data.reserved_withdrawal_amount, 65);
        assert.equal(eligibility.body.data.available_balance, 35);
        const submission = await submit(fixture, 36);
        assert.equal(submission.statusCode, 400);
    });
});

test("rejecting an approved unpaid claim releases its reservation", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        const claimId = await createClaim(fixture, {
            amount: 65,
            status: "APPROVED",
            reviewedBy: fixture.managerId,
        });
        const result = await managerReview(fixture, claimId, "REJECTED");
        assert.equal(result.statusCode, 200);
        assert.equal((await getClaim(claimId)).claim_status, "REJECTED");
        const remaining = await verificationPool.query(
            "SELECT COALESCE(SUM(amount_requested), 0)::numeric AS reserved FROM withdrawal_claims WHERE account_id = $1 AND claim_status = 'APPROVED'",
            [fixture.accountId]
        );
        assert.equal(Number(remaining.rows[0].reserved), 0);
    });
});

test("approval never debits balance or marks a claim paid", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        const claimId = await createClaim(fixture, { amount: 40 });
        const result = await managerReview(fixture, claimId, "APPROVED");
        assert.equal(result.statusCode, 200);
        const claim = await getClaim(claimId);
        assert.equal(claim.claim_status, "APPROVED");
        assert.equal(claim.transaction_id, null);
        assert.equal(claim.processed_at, null);
        assert.equal(await getBalance(fixture.accountId), 100);
    });
});

test("failed submission and review transactions leave no partial claims or audit entries", async () => {
    if (!verifiedTarget) return;
    await withFixture(async (fixture) => {
        const originalConsoleError = console.error;
        console.error = () => {};
        try {
            const failedSubmission = await submit(fixture, 0.001);
            assert.equal(failedSubmission.statusCode, 500);
            const pendingCount = await verificationPool.query(
                "SELECT count(*)::int AS count FROM withdrawal_claims WHERE account_id = $1",
                [fixture.accountId]
            );
            assert.equal(pendingCount.rows[0].count, 0);

            const claimId = await createClaim(fixture, { amount: 40 });
            const failedReview = await fundManagerController.reviewWithdrawal({
                user: { userId: "nonexistent-integration-manager" },
                params: { id: claimId },
                body: { decision: "APPROVED" },
            }, createResponse());
            assert.equal(failedReview.statusCode, 500);
            assert.equal((await getClaim(claimId)).claim_status, "PENDING");
            assert.equal(await getAuditCount(claimId), 0);
            assert.equal(await getBalance(fixture.accountId), 100);
        } finally {
            console.error = originalConsoleError;
        }
    });
});
