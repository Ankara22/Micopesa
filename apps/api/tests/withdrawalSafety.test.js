const { after, afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/db/database");
const darajaProvider = require("../src/services/mpesaService");
const simulatorProvider = require("../src/services/mpesaSimulatorService");

const providerCalls = [];
const providerMethods = [
    [darajaProvider, "initiateStkPush"],
    [darajaProvider, "queryStkPush"],
    [simulatorProvider, "initiateStkPush"],
    [simulatorProvider, "queryStkPush"],
];
const originalProviderMethods = providerMethods.map(([provider, method]) => provider[method]);
providerMethods.forEach(([provider, method]) => {
    provider[method] = async () => providerCalls.push(method);
});

const withdrawalController = require("../src/controllers/withdrawalController");
const fundManagerController = require("../src/controllers/fundManagerController");

after(() => {
    providerMethods.forEach(([provider, method], index) => {
        provider[method] = originalProviderMethods[index];
    });
});

const originalConnect = pool.connect;
const originalQuery = pool.query;
let activeDatabase = null;

class MockWithdrawalDatabase {
    constructor({ balance = 100, accounts, claims = [], funds, allocations } = {}) {
        this.accounts = accounts || [{
            account_id: "account-1",
            user_id: "worker-1",
            current_balance: balance,
            account_status: "ACTIVE",
        }];
        this.users = new Map(this.accounts.map((account) => [
            account.user_id,
            {
                user_id: account.user_id,
                role: "WORKER",
                phone: "254700000001",
                phone_verified_at: "2026-01-01T00:00:00Z",
            },
        ]));
        this.funds = funds || [{ fund_id: "fund-1", managed_by: "manager-1" }];
        this.allocations = allocations || [{
            account_id: "account-1",
            fund_id: "fund-1",
            effective_from: "2000-01-01",
            effective_to: null,
        }];
        this.claims = claims.map((claim, index) => ({
            claim_id: claim.claim_id || `claim-${index + 1}`,
            account_id: claim.account_id || "account-1",
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
        this.queries = [];
        this.managerScopeBindings = [];
    }

    managerScopeMatches(accountId, managerId) {
        const today = new Date().toISOString().slice(0, 10);
        return this.allocations.some((allocation) => {
            const fund = this.funds.find(({ fund_id }) => fund_id === allocation.fund_id);
            return allocation.account_id === accountId &&
                fund?.managed_by === managerId &&
                allocation.effective_from <= today &&
                (!allocation.effective_to || allocation.effective_to >= today);
        });
    }

    managerScopeRows(statement, values, managerPlaceholder, accountId) {
        assert.match(statement, /JOIN funds f ON f\.fund_id = fa\.fund_id/i);
        assert.match(statement, /fa\.account_id = \$1/i);
        assert.match(statement, new RegExp(`f\\.managed_by = \\$${managerPlaceholder}\\b`, "i"));
        assert.match(statement, /fa\.effective_from <= CURRENT_DATE/i);
        assert.match(statement, /fa\.effective_to IS NULL OR fa\.effective_to >= CURRENT_DATE/i);
        this.managerScopeBindings.push({
            managerId: values[managerPlaceholder - 1],
            placeholder: managerPlaceholder,
        });
        return this.managerScopeMatches(accountId, values[managerPlaceholder - 1]);
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
                db.queries.push({ statement, values: [...values], transactionOpen });
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
                if (statement.startsWith("SELECT phone, phone_verified_at FROM users")) {
                    const user = db.users.get(values[0]);
                    return { rows: user?.role === "WORKER" ? [{ ...user }] : [] };
                }
                if (statement.startsWith("SELECT account_id FROM withdrawal_claims WHERE claim_id = $1")) {
                    const claim = findClaim(values[0]);
                    return { rows: claim ? [{ account_id: claim.account_id }] : [] };
                }
                if (statement.startsWith("SELECT claim_id, account_id, claim_status, amount_requested")) {
                    const claim = findClaim(values[0]);
                    return { rows: claim ? [{ transaction_id: null, processed_at: null, ...claim }] : [] };
                }
                if (statement.includes("FROM fund_allocations fa") && statement.includes("f.managed_by = $2")) {
                    assert.match(statement, /FOR SHARE OF fa, f/i);
                    const inScope = db.managerScopeRows(statement, values, 2, values[0]);
                    return { rows: inScope ? [{ fund_id: "fund-1" }] : [] };
                }
                if (statement.includes("COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount")) {
                    assert.match(statement, /claim_status = 'APPROVED'/i);
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
        this.queries.push({ statement, values: [...values], transactionOpen: false });
        if (statement.includes("FROM withdrawal_claims wc")) {
            const managerId = values[0];
            const pendingOnly = statement.includes("wc.claim_status IN ('PENDING', 'APPROVED')");
            assert.match(statement, /EXISTS\s*\(\s*SELECT 1\s+FROM fund_allocations fa/i);
            assert.match(statement, /JOIN funds f ON f\.fund_id = fa\.fund_id/i);
            assert.match(statement, /fa\.account_id = wc\.account_id/i);
            assert.match(statement, /f\.managed_by = \$1/i);
            assert.match(statement, /fa\.effective_from <= CURRENT_DATE/i);
            assert.match(statement, /fa\.effective_to IS NULL OR fa\.effective_to >= CURRENT_DATE/i);
            this.managerScopeBindings.push({ managerId, placeholder: 1 });
            const rows = this.claims.filter((claim) =>
                this.managerScopeMatches(claim.account_id, managerId) &&
                (!pendingOnly || ["PENDING", "APPROVED"].includes(claim.claim_status))
            );
            return { rows: rows.map((claim) => ({
                ...claim,
                user_id: this.accounts.find(({ account_id }) => account_id === claim.account_id)?.user_id,
                full_name: "Worker",
                phone: "254700000001",
            })) };
        }
        if (statement.includes("FROM pension_accounts WHERE user_id = $1")) {
            const account = this.accounts.find((item) => item.user_id === values[0]);
            return { rows: account ? [{ ...account }] : [] };
        }
        if (statement.includes("COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount")) {
            assert.match(statement, /claim_status = 'APPROVED'/i);
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
    activeDatabase = database;
    pool.connect = database.connect;
    pool.query = database.query;
}

async function submit(amount, { destinationPhone = "254700000001", profile = {} } = {}) {
    const databaseUser = profile.user_id || "worker-1";
    const database = activeDatabase;
    if (database) {
        database.users.set(databaseUser, {
            ...(database.users.get(databaseUser) || { user_id: databaseUser, role: "WORKER" }),
            ...profile,
        });
    }
    const res = createResponse();
    await withdrawalController.submitClaim({
        user: { userId: databaseUser },
        body: {
            amount_requested: amount,
            destination_phone: destinationPhone,
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
    activeDatabase = null;
    pool.connect = originalConnect;
    pool.query = originalQuery;
});

test("in-memory account-lock mock serializes submissions, not a PostgreSQL concurrency guarantee", async () => {
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

test("pending claims block a request but are not subtracted as approved reservations", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 1001,
        claims: [{ claim_id: "pending-1", amount_requested: 250, claim_status: "PENDING" }],
    });
    useDatabase(database);

    const eligibility = createResponse();
    await withdrawalController.checkEligibility({ user: { userId: "worker-1" } }, eligibility);
    assert.equal(eligibility.body.data.reserved_withdrawal_amount, 0);
    assert.equal(eligibility.body.data.available_balance, 1001);

    const result = await submit(1);
    assert.equal(result.statusCode, 409);
    assert.equal(database.claims.length, 1);
});

test("withdrawal claim stores only the worker's verified profile phone", async () => {
    const database = new MockWithdrawalDatabase();
    useDatabase(database);

    const result = await submit(10, { destinationPhone: "254700000001" });

    assert.equal(result.statusCode, 201);
    assert.equal(database.claims[0].destination_phone, "254700000001");
});

test("withdrawal claim rejects a client-supplied phone that differs from the verified profile", async () => {
    const database = new MockWithdrawalDatabase();
    useDatabase(database);

    const result = await submit(10, { destinationPhone: "254711111166" });

    assert.equal(result.statusCode, 400);
    assert.match(result.body.message, /match your verified profile phone/i);
    assert.equal(JSON.stringify(result.body).includes("254700000001"), false);
    assert.equal(database.claims.length, 0);
});

test("withdrawal claim uses the verified profile phone when the request omits a destination", async () => {
    const database = new MockWithdrawalDatabase();
    useDatabase(database);
    const res = createResponse();

    await withdrawalController.submitClaim({
        user: { userId: "worker-1" },
        body: { amount_requested: 10, withdrawal_reason: "Medical expense" },
    }, res);

    assert.equal(res.statusCode, 201);
    assert.equal(database.claims[0].destination_phone, "254700000001");
});

test("worker without a verified profile phone cannot submit a withdrawal claim", async () => {
    const database = new MockWithdrawalDatabase();
    useDatabase(database);

    const result = await submit(10, {
        profile: { phone_verified_at: null },
    });

    assert.equal(result.statusCode, 403);
    assert.match(result.body.message, /verified profile phone is required/i);
    assert.equal(database.claims.length, 0);
});

test("manager withdrawal queues include claims only for currently managed funds", async () => {
    const future = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const database = new MockWithdrawalDatabase({
        accounts: [
            { account_id: "account-1", user_id: "worker-1", current_balance: 100, account_status: "ACTIVE" },
            { account_id: "account-2", user_id: "worker-2", current_balance: 100, account_status: "ACTIVE" },
        ],
        claims: [
            { claim_id: "own-claim", account_id: "account-1", claim_status: "PENDING" },
            { claim_id: "other-claim", account_id: "account-2", claim_status: "PENDING" },
        ],
        funds: [
            { fund_id: "fund-1", managed_by: "manager-1" },
            { fund_id: "fund-2", managed_by: "manager-2" },
        ],
        allocations: [
            { account_id: "account-1", fund_id: "fund-1", effective_from: "2000-01-01", effective_to: null },
            { account_id: "account-2", fund_id: "fund-2", effective_from: "2000-01-01", effective_to: null },
            { account_id: "account-2", fund_id: "fund-1", effective_from: future, effective_to: null },
            { account_id: "account-2", fund_id: "fund-1", effective_from: "2000-01-01", effective_to: yesterday },
        ],
    });
    useDatabase(database);

    const pending = createResponse();
    await withdrawalController.getPendingClaims({ user: { userId: "manager-1" } }, pending);
    const history = createResponse();
    await fundManagerController.listWithdrawals({ user: { userId: "manager-1" } }, history);

    assert.deepEqual(pending.body.data.map(({ claim_id }) => claim_id), ["own-claim"]);
    assert.deepEqual(history.body.data.map(({ claim_id }) => claim_id), ["own-claim"]);
    assert.deepEqual(database.managerScopeBindings, [
        { managerId: "manager-1", placeholder: 1 },
        { managerId: "manager-1", placeholder: 1 },
    ]);

    database.funds[0].managed_by = "manager-2";
    const afterOwnershipChange = createResponse();
    await withdrawalController.getPendingClaims(
        { user: { userId: "manager-1" } },
        afterOwnershipChange
    );
    assert.deepEqual(afterOwnershipChange.body.data, []);
    assert.deepEqual(database.managerScopeBindings.at(-1), {
        managerId: "manager-1",
        placeholder: 1,
    });

    database.funds[0].managed_by = "manager-1";
    database.allocations = database.allocations.filter(
        ({ account_id, fund_id }) => !(account_id === "account-1" && fund_id === "fund-1")
    );
    const afterAllocationRemoval = createResponse();
    await withdrawalController.getPendingClaims(
        { user: { userId: "manager-1" } },
        afterAllocationRemoval
    );
    assert.deepEqual(afterAllocationRemoval.body.data, []);
});

test("approval and rejection enforce manager ownership and effective allocation dates", async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const invalidScopes = [
        {
            name: "another manager's fund",
            configure(database) {
                database.funds[0].managed_by = "manager-2";
            },
        },
        {
            name: "removed allocation",
            configure(database) {
                database.allocations = [];
            },
        },
        {
            name: "allocation that starts in the future",
            configure(database) {
                database.allocations[0].effective_from = tomorrow;
            },
        },
        {
            name: "expired allocation",
            configure(database) {
                database.allocations[0].effective_to = yesterday;
            },
        },
    ];

    for (const decision of ["APPROVED", "REJECTED"]) {
        for (const scope of invalidScopes) {
            const claimId = `claim-${decision.toLowerCase()}-${scope.name.replace(/\W+/g, "-")}`;
            const database = new MockWithdrawalDatabase({
                claims: [{ claim_id: claimId, amount_requested: 40 }],
            });
            scope.configure(database);
            useDatabase(database);

            const result = await review(claimId, decision);

            assert.equal(result.statusCode, 404, `${decision} should deny ${scope.name}`);
            assert.equal(database.claims[0].claim_status, "PENDING");
            assert.equal(database.auditLogs.length, 0);
            assert.equal(database.accounts[0].current_balance, 100);
            assert.deepEqual(database.managerScopeBindings, [{ managerId: "manager-1", placeholder: 2 }]);
        }
    }
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

test("multiple approvals cannot reserve more than the balance", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 100,
        claims: [
            { claim_id: "claim-60", claim_status: "PENDING", amount_requested: 60 },
            { claim_id: "claim-50", claim_status: "PENDING", amount_requested: 50 },
        ],
    });
    useDatabase(database);

    const first = await review("claim-60", "APPROVED");
    const second = await review("claim-50", "APPROVED");

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 409);
    assert.equal(database.claims[0].claim_status, "APPROVED");
    assert.equal(database.claims[1].claim_status, "PENDING");
    assert.equal(database.accounts[0].current_balance, 100);
    assert.equal(database.transactions.length, 0);
});

test("an approved claim cannot be approved repeatedly or reserve twice", async () => {
    const database = new MockWithdrawalDatabase({
        balance: 1001,
        claims: [{ claim_id: "claim-250", claim_status: "PENDING", amount_requested: 250 }],
    });
    useDatabase(database);

    const first = await review("claim-250", "APPROVED");
    const repeated = await review("claim-250", "APPROVED");
    const eligibility = createResponse();
    await withdrawalController.checkEligibility({ user: { userId: "worker-1" } }, eligibility);

    assert.equal(first.statusCode, 200);
    assert.equal(repeated.statusCode, 409);
    assert.equal(eligibility.body.data.reserved_withdrawal_amount, 250);
    assert.equal(eligibility.body.data.available_balance, 751);
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

test("withdrawal approval never invokes Daraja or simulator provider methods", async () => {
    const database = new MockWithdrawalDatabase({
        claims: [{ claim_id: "pending-1", amount_requested: 40 }],
    });
    providerCalls.length = 0;
    useDatabase(database);
    const result = await review("pending-1", "APPROVED");
    assert.equal(result.statusCode, 200);
    assert.deepEqual(providerCalls, []);
});

test("claim submission and approval check reservations inside account-locking transactions", async () => {
    const submissionDatabase = new MockWithdrawalDatabase({
        balance: 1001,
        claims: [{ claim_id: "approved-250", claim_status: "APPROVED", amount_requested: 250 }],
    });
    useDatabase(submissionDatabase);

    const submission = await submit(751);
    const approvalDatabase = new MockWithdrawalDatabase({
        balance: 1001,
        claims: [{ claim_id: "claim-250", claim_status: "PENDING", amount_requested: 250 }],
    });
    useDatabase(approvalDatabase);
    const approval = await review("claim-250", "APPROVED");

    assert.equal(submission.statusCode, 201);
    assert.equal(approval.statusCode, 200);
    const submitBegin = submissionDatabase.queries.findIndex(({ statement }) => statement === "BEGIN");
    const submitLock = submissionDatabase.queries.findIndex(({ statement }) =>
        statement.includes("FROM pension_accounts WHERE user_id = $1 FOR UPDATE")
    );
    const submitReservation = submissionDatabase.queries.findIndex(({ statement }) =>
        statement.includes("COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount")
    );
    const submitInsert = submissionDatabase.queries.findIndex(({ statement }) =>
        statement.startsWith("INSERT INTO withdrawal_claims")
    );
    assert.ok(submitBegin >= 0 && submitBegin < submitLock);
    assert.ok(submitLock < submitReservation && submitReservation < submitInsert);

    const approvalBegin = approvalDatabase.queries.findIndex(({ statement }) =>
        statement === "BEGIN"
    );
    const approvalLock = approvalDatabase.queries.findIndex(({ statement }, index) =>
        index > approvalBegin &&
        statement.includes("FROM pension_accounts WHERE account_id = $1 FOR UPDATE")
    );
    const approvalReservation = approvalDatabase.queries.findIndex(({ statement }, index) =>
        index > approvalBegin &&
        statement.includes("COALESCE(SUM(amount_requested), 0)::numeric AS reserved_amount")
    );
    assert.ok(approvalBegin >= 0 && approvalBegin < approvalLock);
    assert.ok(approvalLock < approvalReservation);
    assert.equal(
        submissionDatabase.queries[submitReservation].transactionOpen,
        true
    );
    assert.equal(
        approvalDatabase.queries[approvalReservation].transactionOpen,
        true
    );
    assert.ok(submissionDatabase.queries.some(({ statement }) => statement === "COMMIT"));
    assert.ok(approvalDatabase.queries.some(({ statement }) => statement === "COMMIT"));
    assert.equal(submissionDatabase.queries.some(({ statement }) => /provider|mpesa|settle/i.test(statement)), false);
    assert.equal(approvalDatabase.queries.some(({ statement }) => /provider|mpesa|settle/i.test(statement)), false);
});
