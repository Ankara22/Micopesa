const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");
const pool = require("../src/db/database");
const adminUserRoutes = require("../src/routes/adminUserRoutes");
const adminUserController = require("../src/controllers/adminUserController");
const { requireAuth } = require("../src/middleware/authMiddleware");
const { generateToken } = require("../src/utils/token");
const { hashRateKey } = require("../src/services/authEmailService");
const { normalizeKenyanPhone } = require("../src/utils/kenyanPhone");

const originalJwtSecret = process.env.JWT_SECRET;
process.env.JWT_SECRET ||= "micopesa-admin-deletion-test-secret";

const originalQuery = pool.query;
const originalConnect = pool.connect;
const ADMIN_ID = "A".repeat(25);
const TARGET_ID = "B".repeat(25);
const OTHER_ADMIN_ID = "C".repeat(25);
const WORKER_ID = "D".repeat(25);

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
});

function createState({
    targetRole = "FUND_MANAGER",
    targetStatus = "ACTIVE",
    protectedReferences = [],
} = {}) {
    const target = {
        user_id: TARGET_ID,
        full_name: "Test User",
        role: targetRole,
        account_status: targetStatus,
        auth_version: 0,
        email: "target@example.test",
        pending_email: null,
        phone: "+254712345678",
        email_verified: true,
        phone_verified_at: new Date("2025-01-01T00:00:00.000Z"),
        password_hash: "old-password-hash",
    };
    return {
        users: new Map([
            [ADMIN_ID, {
                user_id: ADMIN_ID,
                role: "ADMIN",
                account_status: "ACTIVE",
                auth_version: 0,
                email: "admin@example.test",
                phone: "+254700000001",
            }],
            [TARGET_ID, target],
            [OTHER_ADMIN_ID, {
                user_id: OTHER_ADMIN_ID,
                role: "ADMIN",
                account_status: "ACTIVE",
                auth_version: 0,
                email: "other-admin@example.test",
                phone: "+254700000003",
            }],
            [WORKER_ID, {
                user_id: WORKER_ID,
                role: "WORKER",
                account_status: "ACTIVE",
                auth_version: 0,
                email: "worker@example.test",
                phone: "+254700000004",
            }],
        ]),
        authTokens: [
            { user_id: TARGET_ID, consumed_at: null },
            { user_id: WORKER_ID, consumed_at: null },
        ],
        phoneChangeChallenges: [
            { user_id: TARGET_ID, pending_phone: "+254711111111", code_hash: "hash" },
            { user_id: WORKER_ID, pending_phone: "+254700000005", code_hash: "other-hash" },
        ],
        ussdSessions: [],
        notificationPreferences: [{ user_id: TARGET_ID }],
        pushSubscriptions: [{ user_id: TARGET_ID }],
        authRateLimits: [
            { scope: "EMAIL", key_hash: hashRateKey("EMAIL:target@example.test") },
            { scope: "ACCOUNT", key_hash: hashRateKey(`ACCOUNT:${TARGET_ID}`) },
            { scope: "EMAIL", key_hash: hashRateKey("EMAIL:unrelated@example.test") },
            { scope: "IP", key_hash: hashRateKey("IP:127.0.0.1") },
        ],
        pendingRegistrations: [
            { email: "target@example.test", phone: "+254712345678" },
            { email: "unrelated@example.test", phone: "+254700000009" },
        ],
        protectedReferences: new Set(protectedReferences),
        history: {
            pensionAccounts: [],
            balances: [],
            contributions: [],
            paymentAttempts: [],
            ledgerEntries: [],
            kycRecords: [],
            complianceHistory: [],
            auditHistory: [],
        },
        auditEvents: [],
        poolQueries: [],
        clientQueries: [],
    };
}

function installDatabase(state, { failOn, missingTables = [] } = {}) {
    pool.query = async (query, values = []) => {
        state.poolQueries.push({ query, values });
        if (query.startsWith("SELECT user_id, full_name, phone, role")) {
            return { rows: [...state.users.values()] };
        }
        if (/SELECT user_id, role, account_status(?:, approval_status)?, auth_version/.test(query)) {
            const user = state.users.get(values[0]);
            return {
                rows: user ? [{
                    ...user,
                    force_password_change: false,
                    is_temp_password: false,
                }] : [],
            };
        }
        assert.fail(`Unexpected pool query: ${query}`);
    };

    pool.connect = async () => {
        let snapshot;
        return {
            async query(query, values = []) {
                state.clientQueries.push({ query, values });

                if (query.includes("FROM information_schema.columns")) {
    const table = values[0];

    if (missingTables.includes(table)) {
        return { rows: [] };
    }

    const columnsByTable = {
        users: [
            "user_id", "role", "account_status", "full_name", "phone",
            "email", "pending_email", "email_verified", "phone_verified_at",
            "password_hash", "auth_version", "is_temp_password",
            "force_password_change", "failed_login_attempts", "locked_until",
            "profile_photo_ref", "updated_at",
        ],
        phone_change_verifications: ["user_id", "pending_phone"],
        kyc_records: ["user_id", "national_id_fingerprint"],
        pending_registrations: ["email", "phone"],
        worker_registration_challenges: ["user_id", "email", "phone"],
        worker_password_reset_challenges: ["user_id"],
        auth_rate_limits: ["scope", "key_hash"],
        auth_tokens: ["user_id"],
        notification_preferences: ["user_id"],
        push_subscriptions: ["user_id"],
        ussd_sessions: ["user_id", "session_status", "ended_at"],
    };

    return {
        rows: (columnsByTable[table] || []).map((column_name) => ({
            column_name,
        })),
    };
}


                if (query === "BEGIN") {
                    snapshot = {
                        users: structuredClone(state.users),
                        authTokens: structuredClone(state.authTokens),
                        phoneChangeChallenges: structuredClone(state.phoneChangeChallenges),
                        ussdSessions: structuredClone(state.ussdSessions),
                        notificationPreferences: structuredClone(state.notificationPreferences),
                        pushSubscriptions: structuredClone(state.pushSubscriptions),
                        authRateLimits: structuredClone(state.authRateLimits),
                        pendingRegistrations: structuredClone(state.pendingRegistrations),
                        history: structuredClone(state.history),
                        auditEvents: structuredClone(state.auditEvents),
                    };
                    return { rows: [] };
                }
                if (query === "ROLLBACK") {
                    state.users = snapshot.users;
                    state.authTokens = snapshot.authTokens;
                    state.phoneChangeChallenges = snapshot.phoneChangeChallenges;
                    state.ussdSessions = snapshot.ussdSessions;
                    state.notificationPreferences = snapshot.notificationPreferences;
                    state.pushSubscriptions = snapshot.pushSubscriptions;
                    state.authRateLimits = snapshot.authRateLimits;
                    state.pendingRegistrations = snapshot.pendingRegistrations;
                    state.history = snapshot.history;
                    state.auditEvents = snapshot.auditEvents;
                    return { rows: [] };
                }
                if (query === "COMMIT") return { rows: [] };
                if (failOn && query.includes(failOn)) {
                    const error = new Error("simulated database failure");
                    error.code = "23503";
                    throw error;
                }
                if (query.includes("SELECT user_id FROM users") && query.includes("FOR UPDATE")) {
                    return {
                        rows: [...state.users.values()]
                            .filter((user) => user.role === "ADMIN" && user.account_status === "ACTIVE")
                            .map(({ user_id }) => ({ user_id })),
                    };
                }
                if (query.includes("FROM users WHERE user_id = $1") && query.startsWith("SELECT")) {
                    const user = state.users.get(values[0]);
                    const isDeleted = Boolean(
                        user?.full_name === "Deleted account" &&
                        user.email === null &&
                        user.pending_email === null &&
                        user.phone_verified_at === null &&
                        /^D[0-9a-f]{14}$/.test(user.phone)
                    );
                    return { rows: user ? [{ ...user, is_deleted: isDeleted }] : [] };
                }
                if (query.includes("SELECT pending_phone FROM phone_change_verifications")) {
                    return {
                        rows: state.phoneChangeChallenges
                            .filter(({ user_id }) => user_id === values[0])
                            .map(({ pending_phone }) => ({ pending_phone })),
                    };
                }
                if (query.includes("SELECT national_id_fingerprint FROM kyc_records")) {
                    return { rows: [] };
                }
                if (query.includes("pg_advisory_xact_lock")) return { rows: [] };
                if (query.includes('DELETE FROM public."pending_registrations"') ||
                     query.includes("DELETE FROM pending_registrations")) {
                    const [emails, phone] = values;
                    state.pendingRegistrations = state.pendingRegistrations.filter((registration) =>
                        !emails.includes(registration.email.toLowerCase()) &&
                        (!phone || normalizeKenyanPhone(registration.phone) !== phone)
                    );
                    return { rows: [] };
                }
                if (
                    query.includes('DELETE FROM public."worker_registration_challenges"') ||
                    query.includes("DELETE FROM worker_registration_challenges")
                ) {
                     return { rows: [] };
                }
                if (query.includes("DELETE FROM auth_rate_limits")) {
                    const [emailHashes, accountHash] = values;
                    state.authRateLimits = state.authRateLimits.filter((limit) =>
                        !(
                            (limit.scope === "EMAIL" && emailHashes.includes(limit.key_hash)) ||
                            (limit.scope === "ACCOUNT" && limit.key_hash === accountHash)
                        )
                    );
                    return { rows: [] };
                }
                if (query.includes("FROM pg_constraint")) {
                    const removableTables = [
                        "auth_tokens",
                        "phone_change_verifications",
                        "notification_preferences",
                        "push_subscriptions",
                        "ussd_sessions",
                    ].filter((table) => !missingTables.includes(table));
                    const protectedTables = [...state.protectedReferences].filter((table) =>
                        ![
                            "audit_logs",
                            "notification_audit_events",
                            "report_download_events",
                            "compliance_report_submissions",
                            "compliance_report_reviews",
                            "pension_adjustment_requests",
                            "pension_adjustment_decision_audit",
                            "pension_account_movements",
                            "withdrawal_payout_retry_decisions",
                        ].includes(table)
                    );
                    return {
                        rows: [...removableTables, ...protectedTables].map((table_name) => ({
                            schema_name: "public",
                            table_name,
                            column_names: ["user_id"],
                        })),
                    };
                }
                if (query.includes("to_regclass")) {
                    const table = String(values[0]).replace(/^public\./, "");
                    return { rows: [{ present: !missingTables.includes(table) }] };
                }
                const foreignReference = query.match(/FROM "public"\."([a-zA-Z0-9_]+)"/);
                const rawReference = query.match(/FROM public\."([a-zA-Z0-9_]+)"/);
                const referenceTable = foreignReference?.[1] || rawReference?.[1];
                if (referenceTable && query.includes("SELECT EXISTS")) {
                    const ussdSessionExists = referenceTable === "ussd_sessions" &&
                        state.ussdSessions.some(({ user_id }) => user_id === TARGET_ID);
                    return { rows: [{
                        present: state.protectedReferences.has(referenceTable) || ussdSessionExists,
                    }] };
                }
                if (query.includes("SELECT 1 FROM users")) {
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM auth_tokens")) {
                    state.authTokens = state.authTokens.filter(({ user_id }) => user_id !== values[0]);
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM phone_change_verifications")) {
                    state.phoneChangeChallenges = state.phoneChangeChallenges.filter(
                        ({ user_id }) => user_id !== values[0]
                    );
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM worker_password_reset_challenges")) {
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM notification_preferences")) {
                    state.notificationPreferences = state.notificationPreferences.filter(
                        ({ user_id }) => user_id !== values[0]
                    );
                    return { rows: [] };
                }
                if (query.includes("DELETE FROM push_subscriptions")) {
                    state.pushSubscriptions = state.pushSubscriptions.filter(
                        ({ user_id }) => user_id !== values[0]
                    );
                    return { rows: [] };
                }
                if (query.includes("UPDATE ussd_sessions")) {
                    for (const session of state.ussdSessions.filter(({ user_id, session_status }) =>
                        user_id === values[0] && session_status === "ACTIVE"
                    )) {
                        session.session_status = "EXPIRED";
                        session.ended_at = session.ended_at || "expired";
                    }
                    return { rows: [] };
                }
                if (query.includes("UPDATE users") && query.includes("SET full_name = 'Deleted account'")) {
                    const [phone, passwordHash, userId] = values;
                    const user = state.users.get(userId);
                    if (!user) return { rows: [] };
                    Object.assign(user, {
                        full_name: "Deleted account",
                        phone,
                        phone_verified_at: null,
                        email: null,
                        pending_email: null,
                        email_verified: false,
                        password_hash: passwordHash,
                        account_status: "SUSPENDED",
                        auth_version: user.auth_version + 1,
                        profile_photo_ref: null,
                    });
                    return { rows: [{ user_id: userId }] };
                }
                if (query.includes("DELETE FROM users")) {
                    const deleted = state.users.delete(values[0]);
                    return { rows: deleted ? [{ user_id: values[0] }] : [] };
                }
                if (query.includes("SET account_status = $1")) {
                    const [status, userId] = values;
                    const user = state.users.get(userId);
                    if (!user) return { rows: [] };
                    if (user.account_status !== status) user.auth_version += 1;
                    user.account_status = status;
                    return { rows: [{ ...user }] };
                }
                if (query.includes("UPDATE phone_change_verifications")) {
                    for (const challenge of state.phoneChangeChallenges.filter(({ user_id, pending_phone }) =>
                        user_id === values[0] && pending_phone !== null
                    )) {
                        challenge.pending_phone = null;
                        challenge.code_hash = null;
                        challenge.code_salt = null;
                        challenge.expires_at = null;
                    }
                    return { rows: [] };
                }
                if (query.includes("INSERT INTO audit_logs")) {
                    state.auditEvents.push({ query, values });
                    return { rows: [] };
                }
                assert.fail(`Unexpected transaction query: ${query}`);
            },
            release() {},
        };
    };
}

async function createApi(state, options) {
    installDatabase(state, options);
    const app = express();
    app.use(express.json());
    app.use("/api/admin/users", adminUserRoutes);
    app.get("/api/me", requireAuth, (req, res) => res.json({ userId: req.user.userId }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        request(path, {
            userId = ADMIN_ID,
            role = "ADMIN",
            method = "DELETE",
            authVersion = state.users.get(userId)?.auth_version ?? 0,
            body,
        } = {}) {
            const token = generateToken({ userId, role, authVersion });
            const headers = { Authorization: `Bearer ${token}` };
            if (body !== undefined) headers["Content-Type"] = "application/json";
            return fetch(`${baseUrl}${path}`, {
                method,
                headers,
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            });
        },
        close: () => new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        }),
    };
}

test("permanently deletes an unreferenced user and releases signup identities", async () => {
    const state = createState();
    const api = await createApi(state);
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.data.deletion.outcome, "PERMANENTLY_DELETED");
        assert.equal(body.data.deletion.history_retained, false);
        assert.equal(body.data.deletion.contact_details_released, true);
        assert.equal(state.users.has(TARGET_ID), false);
        assert.equal(state.authTokens.some(({ user_id }) => user_id === TARGET_ID), false);
        assert.equal(state.authRateLimits.some(({ scope, key_hash }) =>
            scope === "EMAIL" && key_hash === hashRateKey("EMAIL:target@example.test")
        ), false);
        assert.equal(state.authRateLimits.some(({ scope, key_hash }) =>
            scope === "ACCOUNT" && key_hash === hashRateKey(`ACCOUNT:${TARGET_ID}`)
        ), false);
        assert.equal(state.authRateLimits.some(({ scope }) => scope === "IP"), true);
        assert.equal(state.phoneChangeChallenges.some(({ user_id }) => user_id === TARGET_ID), false);
        assert.equal(state.pendingRegistrations.some(({ email }) => email === "target@example.test"), false);
        assert.equal(state.pendingRegistrations.length, 1);
        assert.equal((await api.request("/api/me", {
            userId: TARGET_ID,
            role: "FUND_MANAGER",
            authVersion: 0,
            method: "GET",
        })).status, 401);
        assert.equal(state.auditEvents.length, 1);
        assert.deepEqual(state.auditEvents[0].values.slice(0, 4), [
            ADMIN_ID,
            "DELETE",
            "USERS_ACCOUNT",
            TARGET_ID,
        ]);
        assert.equal(JSON.parse(state.auditEvents[0].values[4]).outcome, "PERMANENTLY_DELETED");
    } finally {
        await api.close();
    }
});

test("user listing works without the retired approval column", async () => {
    const state = createState();
    const api = await createApi(state);
    try {
        const response = await api.request("/api/admin/users", { method: "GET" });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.data.some(({ user_id }) => user_id === TARGET_ID), true);
        assert.equal(state.poolQueries.some(({ query }) => query.includes("approval_status")), false);
    } finally {
        await api.close();
    }
});

test("deletion succeeds when optional identity and session tables are absent", async () => {
    const state = createState();
    const api = await createApi(state, {
        missingTables: [
            "auth_rate_limits",
            "auth_tokens",
            "kyc_records",
            "notification_preferences",
            "pending_registrations",
            "phone_change_verifications",
            "push_subscriptions",
            "ussd_sessions",
            "worker_password_reset_challenges",
            "worker_registration_challenges",
        ],
    });
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.data.deletion.outcome, "PERMANENTLY_DELETED");
        assert.equal(state.users.has(TARGET_ID), false);
        for (const table of [
            "phone_change_verifications",
            "worker_registration_challenges",
            "worker_password_reset_challenges",
            "notification_preferences",
            "push_subscriptions",
            "ussd_sessions",
        ]) {
            assert.equal(
                state.clientQueries.some(({ query }) => query.includes(`FROM ${table}`) || query.includes(`INTO ${table}`)),
                false,
                `unexpected SQL for absent table ${table}`,
            );
        }
    } finally {
        await api.close();
    }
});

test("retains protected history under the original ID while anonymizing and revoking access", async () => {
    const state = createState({
        protectedReferences: ["pension_accounts", "notification_audit_events", "audit_logs"],
    });
    state.history = {
        pensionAccounts: [{ account_id: "ACCOUNT-1", user_id: TARGET_ID }],
        balances: [{ account_id: "ACCOUNT-1", amount: "9100.00" }],
        contributions: [{ contribution_id: "CONTRIBUTION-1", account_id: "ACCOUNT-1" }],
        paymentAttempts: [{ attempt_id: "PAYMENT-1", user_id: TARGET_ID }],
        ledgerEntries: [{ ledger_id: "LEDGER-1", account_id: "ACCOUNT-1" }],
        kycRecords: [{ kyc_id: "KYC-1", user_id: TARGET_ID }],
        complianceHistory: [{ report_id: "REPORT-1", generated_by: TARGET_ID }],
        auditHistory: [{ event_id: "AUDIT-1", user_id: TARGET_ID }],
    };
    state.ussdSessions.push({
        session_id: "SESSION-1",
        user_id: TARGET_ID,
        session_status: "ACTIVE",
        ended_at: null,
    });
    const historyBefore = structuredClone(state.history);
    const api = await createApi(state);
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        const body = await response.json();
        const tombstone = state.users.get(TARGET_ID);

        assert.equal(response.status, 200);
        assert.equal(body.data.deletion.outcome, "ANONYMIZED");
        assert.equal(body.data.deletion.history_retained, true);
        assert.equal(tombstone.full_name, "Deleted account");
        assert.equal(tombstone.email, null);
        assert.equal(tombstone.pending_email, null);
        assert.notEqual(tombstone.phone, "+254712345678");
        assert.equal(tombstone.phone.length, 15);
        assert.equal(tombstone.phone_verified_at, null);
        assert.equal(tombstone.email_verified, false);
        assert.notEqual(tombstone.password_hash, "old-password-hash");
        assert.equal(tombstone.account_status, "SUSPENDED");
        assert.equal(tombstone.auth_version, 1);
        assert.deepEqual(state.history, historyBefore);
        assert.equal(state.authTokens.some(({ user_id }) => user_id === TARGET_ID), false);
        assert.equal(state.phoneChangeChallenges.some(({ user_id }) => user_id === TARGET_ID), false);
        assert.equal(state.notificationPreferences.some(({ user_id }) => user_id === TARGET_ID), false);
        assert.equal(state.pushSubscriptions.some(({ user_id }) => user_id === TARGET_ID), false);
        assert.equal(state.ussdSessions[0].session_status, "EXPIRED");
        assert.ok(state.ussdSessions[0].ended_at);
        const reactivate = await api.request(`/api/admin/users/${TARGET_ID}/status`, {
            method: "PATCH",
            body: { account_status: "ACTIVE" },
        });
        assert.equal(reactivate.status, 409);
        assert.equal(state.users.get(TARGET_ID).account_status, "SUSPENDED");
        const roleChange = await api.request(`/api/admin/users/${TARGET_ID}/role`, {
            method: "PATCH",
            body: { role: "ADMIN" },
        });
        assert.equal(roleChange.status, 409);
        assert.equal(state.users.get(TARGET_ID).role, "FUND_MANAGER");
        const repeatDelete = await api.request(`/api/admin/users/${TARGET_ID}`);
        assert.equal(repeatDelete.status, 409);
        assert.equal(state.auditEvents.length, 1);
        assert.equal(JSON.parse(state.auditEvents[0].values[4]).outcome, "ANONYMIZED");
        assert.equal((await api.request("/api/me", {
            userId: TARGET_ID,
            role: "FUND_MANAGER",
            authVersion: 0,
            method: "GET",
        })).status, 403);
    } finally {
        await api.close();
    }
});

test("a raw audit reference without a user foreign key forces history-preserving deletion", async () => {
    const state = createState({ protectedReferences: ["audit_logs"] });
    state.history.auditHistory.push({
        event_id: "AUDIT-USER-1",
        entity_name: "USERS_ROLE",
        entity_id: TARGET_ID,
    });
    const api = await createApi(state);
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.data.deletion.outcome, "ANONYMIZED");
        assert.equal(state.users.has(TARGET_ID), true);
        assert.equal(state.users.get(TARGET_ID).email, null);
        assert.equal(state.history.auditHistory[0].entity_id, TARGET_ID);
    } finally {
        await api.close();
    }
});

test("a suspended account is still deleted rather than silently left deactivated", async () => {
    const state = createState({ targetStatus: "SUSPENDED" });
    const api = await createApi(state);
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.data.deletion.outcome, "PERMANENTLY_DELETED");
        assert.equal(state.users.has(TARGET_ID), false);
    } finally {
        await api.close();
    }
});

test("non-admins are denied, nonexistent targets return 404, and self-deletion is rejected", async () => {
    const state = createState();
    const api = await createApi(state);
    try {
        assert.equal((await api.request(`/api/admin/users/${TARGET_ID}`, {
            userId: WORKER_ID,
            role: "WORKER",
        })).status, 403);
        assert.equal((await api.request(`/api/admin/users/${"E".repeat(25)}`)).status, 404);
        assert.equal((await api.request(`/api/admin/users/${ADMIN_ID}`)).status, 400);
        assert.equal(state.users.has(TARGET_ID), true);
    } finally {
        await api.close();
    }
});

test("the final active administrator cannot be deleted", async () => {
    const state = createState({ targetRole: "ADMIN" });
    state.users.get(ADMIN_ID).account_status = "SUSPENDED";
    state.users.get(OTHER_ADMIN_ID).account_status = "SUSPENDED";
    installDatabase(state);
    const response = {
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

    await adminUserController.deleteUser({
        user: { userId: WORKER_ID },
        params: { userId: TARGET_ID },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /final active administrator/i);
    assert.equal(state.users.has(TARGET_ID), true);
});

test("unsupported system roles are protected from deletion", async () => {
    const state = createState({ targetRole: "SYSTEM" });
    installDatabase(state);
    const response = {
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

    await adminUserController.deleteUser({
        user: { userId: WORKER_ID },
        params: { userId: TARGET_ID },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /protected system accounts/i);
    assert.equal(state.users.has(TARGET_ID), true);
});

test("audit persistence failure rolls back account deletion and contact cleanup", async () => {
    const state = createState();
    const api = await createApi(state, { failOn: "INSERT INTO audit_logs" });
    try {
        const response = await api.request(`/api/admin/users/${TARGET_ID}`);
        assert.equal(response.status, 500);
        assert.equal(state.users.has(TARGET_ID), true);
        assert.equal(state.users.get(TARGET_ID).email, "target@example.test");
        assert.equal(state.users.get(TARGET_ID).phone, "+254712345678");
        assert.equal(state.pendingRegistrations.length, 2);
        assert.equal(state.auditEvents.length, 0);
    } finally {
        await api.close();
    }
});

test("the status endpoint still protects the final active administrator", async () => {
    const state = createState({ targetRole: "ADMIN" });
    state.users.get(ADMIN_ID).account_status = "SUSPENDED";
    state.users.get(OTHER_ADMIN_ID).account_status = "SUSPENDED";
    installDatabase(state);
    const response = {
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

    await adminUserController.updateUserStatus({
        user: { userId: WORKER_ID },
        params: { userId: TARGET_ID },
        body: { account_status: "SUSPENDED" },
    }, response);

    assert.equal(response.statusCode, 409);
    assert.match(response.body.message, /final active administrator/i);
    assert.equal(state.users.get(TARGET_ID).account_status, "ACTIVE");
});
