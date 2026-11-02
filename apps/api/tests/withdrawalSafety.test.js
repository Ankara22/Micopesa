const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/db/database");
const withdrawalController = require("../src/controllers/withdrawalController");
const fundManagerController = require("../src/controllers/fundManagerController");

const originalConnect = pool.connect;
const originalQuery = pool.query;

class MockWithdrawalDatabase {
    constructor({ balance = 100, claims = [] } = {}) {
        this.accounts = [{
            account_id: "account-1",
            user_id: "worker-1",
            current_balance: balance,
            account_status: "ACTIVE",
        }];
        this.claims = claims.map((claim, index) => ({
            claim_id: claim.claim_id || `claim-${index + 1}`,
            account_id: "account-1",
            claim_status: "PENDING",
            amount_requested: 1,
            destination_phone: "254700000001",
            withdrawal_reason: "Medical expense",
            ...claim,
        }));
        this.auditLogs = [];
        this.transactions = [];
        this.failAudit = false;
        this.nextClaimId = this.claims.length + 1;
        this.lockTails = new Map();
        this.connectCount = 0;
    }

    async acquire(key) {
        const previous = this.lockTails.get(key) || Promise.resolve();
        let unlock;
        const current = new Promise((resolve) => { unlock = resolve; });
        this.lockTails.set(key, current);
        await previous;
        return unlock;
    }

    connect = async () => {
        this.connectCount += 1;
        const db = this;
        const stagedClaims = new Map();
        const stagedInserts = [];
        const stagedAudit = [];
        const releases = [];
        let transactionOpen = false;

        function findClaim(id) {
            return stagedClaims.get(id) || db.claims.find((claim) => claim.claim_id === id);
        }

        function allClaims() {
            const merged = db.claims.map((claim) => stagedClaims.get(claim.claim_id) || claim);
            return [...merged, ...stagedInserts];
        }

        function releaseLocks() {
            for (const release of releases.splice(0).reverse()) release();
        }

        return {
            async query(sql, values = []) {
                const statement = sql.replace(/\s+/g, " ").trim();
                if (statement === "BEGIN") {
                    transactionOpen = true;
                    return { rows: [] };
                }
                if (statement === "COMMIT") {
                    db.claims = db.claims.map((claim) => stagedClaims.get(claim.claim_id) || claim);
                    db.claims.push(...stagedInserts);
                    db.auditLogs.push(...stagedAudit);
                    transactionOpen = false;
                    releaseLocks();
                    return { rows: [] };
                }
                if (statement === "ROLLBACK") {
                    transactionOpen = false;
                    releaseLocks();
                    return { rows: [] };
                }
                if (statement.includes("FROM pension_accounts WHERE user_id = $1")) {
                    const account = db.accounts.find((item) => item.user_id === values[0]);
                    if (statement.endsWith("FOR UPDATE") && account) {
                        releases.push(await db.acquire(`account:${account.account_id}`));
                    }
                    return { rows: account ? [{ ...account }] : [] };
                }
                if (statement.includes("FROM pension_accounts WHERE account_id = $1 FOR UPDATE")) {
                    const account = db.accounts.find((item) => item.account_id === values[0]);
                    if (account) releases.push(await db.acquire(`account:${account.account_id}`));
                    return { rows: account ? [{ ...account }] : [] };
                }
                if (statement.startsWith("SELECT account_id FROM withdrawal_claims WHERE claim_id = $1")) {
                    const claim = findClaim(values[0]);
                    return { rows: claim ? [{ account_id: claim.account_id }] : [] };
                }
                if (statement.startsWith("SELECT claim_id, account_id, claim_status, amount_requested")) {
                    const claim = findClaim(values[0]);
                    return { rows: claim ? [{ transaction_id: null, processed_at: null, ...claim }] : [] };
                }
                if (statement.includes("COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount")) {
                    const total = allClaims()
                        .filter((claim) => claim.account_id === values[0] && claim.claim_status === "APPROVED")
                        .reduce((sum, claim) => sum + Number(claim.amount_requested), 0);
                    return { rows: [{ reserved_amount: String(total) }] };
                }
                if (statement.startsWith("SELECT 1 FROM withdrawal_claims")) {
                    const pending = allClaims().find(
                        (claim) => claim.account_id === values[0] && claim.claim_status === "PENDING"
                    );
                    return { rows: pending ? [{ "?column?": 1 }] : [] };
                }
                if (statement.startsWith("INSERT INTO withdrawal_claims")) {
                    const claim = {
                        claim_id: `claim-${db.nextClaimId++}`,
                        account_id: values[0],
                        amount_requested: values[1],
                        destination_phone: values[2],
                        withdrawal_reason: values[3],
                        claim_status: "PENDING",
                    };
                    stagedInserts.push(claim);
                    return { rows: [{ ...claim, requested_at: "now" }] };
                }
                if (statement.startsWith("UPDATE withdrawal_claims")) {
                    const [reviewer, status, claimId] = values;
                    const current = findClaim(claimId);
                    if (!current) return { rows: [] };
                    const updated = { ...current, reviewed_by: reviewer, claim_status: status, reviewed_at: "now" };
                    if (stagedInserts.some((claim) => claim.claim_id === claimId)) {
                        Object.assign(stagedInserts.find((claim) => claim.claim_id === claimId), updated);
                    } else {
                        stagedClaims.set(claimId, updated);
                    }
                    return { rows: [{ ...updated }] };
                }
                if (statement.startsWith("INSERT INTO audit_logs")) {
                    if (db.failAudit) throw new Error("audit insert failed");
                    stagedAudit.push({ user_id: values[0], action_type: values[1], entity_id: values[3] });
                    return { rows: [] };
                }
                throw new Error(`Unexpected test query: ${statement}`);
            },
            release() {
                if (transactionOpen) releaseLocks();
            },
        };
    };

    query = async (sql, values = []) => {
        const statement = sql.replace(/\s+/g, " ").trim();
        if (statement.includes("FROM pension_accounts WHERE user_id = $1")) {
            const account = this.accounts.find((item) => item.user_id === values[0]);
            return { rows: account ? [{ ...account }] : [] };
        }
        if (statement.includes("COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount")) {
            const amount = this.claims
                .filter((claim) => claim.account_id === values[0] && claim.claim_status === "APPROVED")
                .reduce((sum, claim) => sum + Number(claim.amount_requested), 0);
            return { rows: [{ reserved_amount: String(amount) }] };
        }
        if (statement.includes("SELECT count(*)::int AS pending_count")) {
            return {
                rows: [{
                    pending_count: this.claims.filter(
                        (claim) => claim.account_id === values[0] && claim.claim_status === "PENDING"
                    ).length,
                }],
            };
        }
        throw new Error(`Unexpected pool query: ${statement}`);
    };
}

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

function useDatabase(database) {
    pool.connect = database.connect;
    pool.query = database.query;
}

async function submit(amount) {
    const res = createResponse();
    await withdrawalController.submitClaim({
        user: { userId: "worker-1" },
        body: {
            amount_requested: amount,
            destination_phone: "254700000001",
            withdrawal_reason: "Medical expense",
        },
    }, res);
    return res;
}

async function review(claimId, decision) {
    const res = createResponse();
    const handler = decision === "APPROVED"
        ? withdrawalController.approveClaim
        : withdrawalController.rejectClaim;
    await handler({
        user: { userId: "manager-1" },
        params: { claimId },
    }, res);
    return res;
}

afterEach(() => {
    pool.connect = originalConnect;
    pool.query = originalQuery;
});

test("simultaneous submissions serialize and preserve one pending claim per account", async () => {
    const database = new MockWithdrawalDatabase({ balance: 100 });
    useDatabase(database);
    const results = await Promise.all([submit(60), submit(60)]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [201, 409]);
    assert.equal(database.claims.filter((claim) => claim.claim_status === "PENDING").length, 1);
    assert.equal(database.transactions.length, 0);
});

test("pending claim restriction rejects another submission", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 100,
        claims: [{ claim_id: "pending-1", amount_requested: 10 }],
    });
    useDatabase(database);
    const result = await submit(10);
    assert.equal(result.statusCode, 409);
    assert.equal(database.claims.length, 1);
});

test("concurrent approval attempts for the same claim record only one decision", async () => {
    const database = new MockWithdrawalDatabase({
        claims: [{ claim_id: "pending-1", amount_requested: 40 }],
    });
    useDatabase(database);
    const results = await Promise.all([
        review("pending-1", "APPROVED"),
        review("pending-1", "APPROVED"),
    ]);
    assert.deepEqual(results.map((result) => result.statusCode).sort(), [200, 409]);
    assert.equal(database.claims[0].claim_status, "APPROVED");
    assert.equal(database.auditLogs.length, 1);
    assert.equal(database.accounts[0].current_balance, 100);
    assert.equal(database.transactions.length, 0);
});

test("approval checks other approved-unpaid reservations before approving", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 100,
        claims: [
            { claim_id: "approved-1", claim_status: "APPROVED", amount_requested: 70 },
            { claim_id: "pending-2", claim_status: "PENDING", amount_requested: 40 },
        ],
    });
    useDatabase(database);
    const result = await review("pending-2", "APPROVED");
    assert.equal(result.statusCode, 409);
    assert.match(result.body.message, /available balance/i);
    assert.equal(database.claims[1].claim_status, "PENDING");
    assert.equal(database.auditLogs.length, 0);
});

test("approved unpaid claims reduce worker available balance", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 100,
        claims: [{ claim_id: "approved-1", claim_status: "APPROVED", amount_requested: 65 }],
    });
    useDatabase(database);
    const res = createResponse();
    await withdrawalController.checkEligibility({ user: { userId: "worker-1" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.current_balance, 100);
    assert.equal(res.body.data.reserved_withdrawal_amount, 65);
    assert.equal(res.body.data.available_balance, 35);

    const tooLarge = await submit(36);
    assert.equal(tooLarge.statusCode, 400);
});

test("rejecting an approved unpaid claim releases its reservation", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 100,
        claims: [
            { claim_id: "approved-1", claim_status: "APPROVED", amount_requested: 65 },
            { claim_id: "pending-2", claim_status: "PENDING", amount_requested: 20 },
        ],
    });
    useDatabase(database);
    const result = await review("approved-1", "REJECTED");
    assert.equal(result.statusCode, 200);
    assert.equal(database.claims[0].claim_status, "REJECTED");

    const eligibility = createResponse();
    await withdrawalController.checkEligibility({ user: { userId: "worker-1" } }, eligibility);
    assert.equal(eligibility.body.data.reserved_withdrawal_amount, 0);
    assert.equal(eligibility.body.data.available_balance, 100);
});

test("audit failure rolls back the review and leaves approval unpaid", async () => {
    const database = new MockWithdrawalDatabase({
        claims: [{ claim_id: "pending-1", amount_requested: 40 }],
    });
    database.failAudit = true;
    useDatabase(database);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const result = await review("pending-1", "APPROVED");
        assert.equal(result.statusCode, 500);
        assert.equal(database.claims[0].claim_status, "PENDING");
        assert.equal(database.auditLogs.length, 0);
        assert.equal(database.accounts[0].current_balance, 100);
        assert.equal(database.transactions.length, 0);
    } finally {
        console.error = originalConsoleError;
    }
});

test("approval alone never marks a claim paid or debits the account", async () => {
    const database = new MockWithdrawalDatabase({
        claims: [{ claim_id: "pending-1", amount_requested: 40 }],
    });
    useDatabase(database);
    const result = await review("pending-1", "APPROVED");
    assert.equal(result.statusCode, 200);
    assert.equal(database.claims[0].claim_status, "APPROVED");
    assert.notEqual(database.claims[0].claim_status, "PAID");
    assert.equal(database.accounts[0].current_balance, 100);
    assert.equal(database.transactions.length, 0);
});
