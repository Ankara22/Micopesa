const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const pool = require("../src/db/database");
const { requireRole, requireVerifiedKyc } = require("../src/middleware/authMiddleware");
const {
    listDuplicateSubmissions,
    listPendingSubmissions,
    reviewSubmission,
} = require("../src/controllers/kycReviewController");

const originalQuery = pool.query;
const originalConnect = pool.connect;

after(() => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
});

function response() {
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

test("pending KYC cannot access financial routes; verified KYC may proceed", async () => {
    let status = "PENDING";
    pool.query = async (query, values) => {
        assert.match(query, /FROM kyc_records WHERE user_id = \$1/);
        assert.deepEqual(values, ["worker-1"]);
        return { rows: [{ kyc_status: status }] };
    };
    const req = { user: { userId: "worker-1" } };
    const pendingResponse = response();
    let nextCalls = 0;
    await requireVerifiedKyc(req, pendingResponse, () => { nextCalls += 1; });
    assert.equal(pendingResponse.statusCode, 403);
    assert.equal(pendingResponse.body.code, "KYC_VERIFICATION_REQUIRED");
    assert.equal(nextCalls, 0);

    status = "REJECTED";
    const rejectedResponse = response();
    await requireVerifiedKyc(req, rejectedResponse, () => { nextCalls += 1; });
    assert.equal(rejectedResponse.statusCode, 403);
    assert.equal(nextCalls, 0);

    status = "VERIFIED";
    await requireVerifiedKyc(req, response(), () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
});

test("KYC review role guard allows admins and rejects workers", () => {
    const middleware = requireRole("ADMIN");
    const denied = response();
    let nextCalls = 0;
    middleware({ user: { role: "WORKER" } }, denied, () => { nextCalls += 1; });
    assert.equal(denied.statusCode, 403);
    assert.equal(nextCalls, 0);

    middleware({ user: { role: "ADMIN" } }, response(), () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
});

test("admin pending KYC list includes review context, masks National IDs, and marks duplicates", async () => {
    let query;
    pool.query = async (statement) => {
        query = statement;
        return { rows: [{
            kyc_id: "kyc-1",
            user_id: "worker-1",
            full_name: "Worker One",
            email: "worker@example.test",
            phone: "+254700000001",
            date_of_birth: "1990-04-15",
            national_id_last_four: "1234",
            kyc_status: "PENDING",
            duplicate_submission: true,
        }] };
    };
    const res = response();
    await listPendingSubmissions({}, res);
    assert.equal(res.statusCode, 200);
    assert.match(query, /WHERE k\.kyc_status = 'PENDING'/);
    assert.match(query, /right\(k\.national_id, 4\)/);
    assert.doesNotMatch(query, /(?:^|,)\s*k\.national_id\s*(?:,|FROM)/i);
    assert.equal(res.body.data[0].masked_national_id, "****1234");
    assert.equal(res.body.data[0].duplicate_submission, true);
    assert.equal(Object.hasOwn(res.body.data[0], "national_id"), false);
    assert.equal(Object.hasOwn(res.body.data[0], "national_id_last_four"), false);
});

test("admin duplicate review list returns only masked National IDs", async () => {
    let query;
    pool.query = async (statement) => {
        query = statement;
        return { rows: [{
            kyc_id: "kyc-1",
            user_id: "worker-1",
            full_name: "Worker One",
            email: "worker@example.com",
            date_of_birth: "1990-04-15",
            national_id_last_four: "1234",
            kyc_status: "PENDING",
        }] };
    };
    const res = response();
    await listDuplicateSubmissions({}, res);
    assert.equal(res.statusCode, 200);
    assert.match(query, /duplicate_submission IS TRUE/);
    assert.match(query, /right\(k\.national_id, 4\)/);
    assert.doesNotMatch(query, /(?:^|,)\s*k\.national_id\s*(?:,|FROM)/i);
    assert.equal(res.body.data[0].masked_national_id, "****1234");
    assert.equal(Object.hasOwn(res.body.data[0], "national_id"), false);
    assert.equal(Object.hasOwn(res.body.data[0], "duplicate_submission"), false);
});

test("admin approval persists a pending-only transition and audit record atomically", async () => {
    const statements = [];
    pool.connect = async () => ({
        async query(query, values) {
            statements.push({ query, values });
            if (query.startsWith("SELECT kyc_id, kyc_status")) {
                return { rows: [{ kyc_id: "kyc-approve", kyc_status: "PENDING" }] };
            }
            if (query.startsWith("UPDATE kyc_records")) {
                assert.match(query, /SET kyc_status = \$1::varchar/);
                assert.match(query, /CASE WHEN \$1::varchar = 'VERIFIED'/);
                assert.match(query, /WHERE kyc_id = \$2 AND kyc_status = 'PENDING'/);
                return { rows: [{
                    kyc_id: "kyc-approve",
                    user_id: "worker-1",
                    kyc_status: "VERIFIED",
                    verified_at: "2026-11-10T00:00:00.000Z",
                }] };
            }
            return { rows: [] };
        },
        release() {},
    });

    const res = response();
    await reviewSubmission({
        params: { kycId: "kyc-approve" },
        body: { status: "VERIFIED" },
        user: { userId: "admin-1" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.submission.kyc_status, "VERIFIED");
    assert.equal(Object.hasOwn(res.body.data.submission, "duplicate_submission"), false);
    const audit = statements.find(({ query }) => query.includes("INSERT INTO audit_logs"));
    assert.ok(audit);
    assert.equal(audit.values[0], "admin-1");
    assert.equal(audit.values[1], "APPROVE");
    assert.equal(audit.values[2], "KYC_RECORD");
    assert.equal(audit.values[3], "kyc-approve");
    assert.deepEqual(JSON.parse(audit.values[4]), { status: "VERIFIED" });
    assert.ok(statements.some(({ query }) => query === "COMMIT"));
    assert.equal(statements.some(({ query }) => query === "ROLLBACK"), false);
});

test("admin KYC approval rolls back when the status update fails with an indeterminate parameter type", async () => {
    const statements = [];
    pool.connect = async () => ({
        async query(query) {
            statements.push(query);
            if (query.startsWith("SELECT kyc_id, kyc_status")) {
                return { rows: [{ kyc_id: "kyc-approve", kyc_status: "PENDING" }] };
            }
            if (query.startsWith("UPDATE kyc_records")) {
                assert.match(query, /\$1::varchar/);
                throw Object.assign(new Error("could not determine data type of parameter"), {
                    code: "42P08",
                });
            }
            return { rows: [] };
        },
        release() {},
    });

    const res = response();
    await reviewSubmission({
        params: { kycId: "kyc-approve" },
        body: { status: "VERIFIED" },
        user: { userId: "admin-1" },
    }, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, "Unable to update this KYC submission.");
    assert.ok(statements.includes("ROLLBACK"));
    assert.equal(statements.includes("COMMIT"), false);
    assert.equal(statements.some((query) => query.includes("INSERT INTO audit_logs")), false);
});

test("admin rejection persists a pending-only transition and audit record atomically", async () => {
    const statements = [];
    pool.connect = async () => ({
        async query(query, values) {
            statements.push({ query, values });
            if (query.startsWith("SELECT kyc_id, kyc_status")) {
                return { rows: [{ kyc_id: "kyc-reject", kyc_status: "PENDING" }] };
            }
            if (query.startsWith("UPDATE kyc_records")) {
                return { rows: [{
                    kyc_id: "kyc-reject",
                    user_id: "worker-2",
                    kyc_status: "REJECTED",
                    verified_at: null,
                }] };
            }
            return { rows: [] };
        },
        release() {},
    });

    const res = response();
    await reviewSubmission({
        params: { kycId: "kyc-reject" },
        body: { status: "REJECTED" },
        user: { userId: "admin-1" },
    }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.submission.kyc_status, "REJECTED");
    const audit = statements.find(({ query }) => query.includes("INSERT INTO audit_logs"));
    assert.ok(audit);
    assert.equal(audit.values[1], "REJECT");
    assert.deepEqual(JSON.parse(audit.values[4]), { status: "REJECTED" });
    assert.ok(statements.some(({ query }) => query === "COMMIT"));
});

test("admin cannot review a non-pending KYC record or create an audit event", async () => {
    const statements = [];
    pool.connect = async () => ({
        async query(query) {
            statements.push(query);
            if (query.startsWith("SELECT kyc_id, kyc_status")) {
                return { rows: [{ kyc_id: "kyc-reviewed", kyc_status: "VERIFIED" }] };
            }
            return { rows: [] };
        },
        release() {},
    });
    const res = response();
    await reviewSubmission({
        params: { kycId: "kyc-reviewed" },
        body: { status: "REJECTED" },
        user: { userId: "admin-1" },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "KYC_SUBMISSION_ALREADY_REVIEWED");
    assert.equal(statements.includes("ROLLBACK"), true);
    assert.equal(statements.some((query) => query.startsWith("UPDATE kyc_records")), false);
    assert.equal(statements.some((query) => query.includes("INSERT INTO audit_logs")), false);
});

test("admin approval reports verified National ID conflicts without database details", async () => {
    const statements = [];
    pool.connect = async () => ({
        async query(query) {
            statements.push(query);
            if (query.startsWith("SELECT kyc_id, kyc_status")) {
                return { rows: [{ kyc_id: "kyc-2", kyc_status: "PENDING" }] };
            }
            if (query.startsWith("UPDATE kyc_records")) {
                throw Object.assign(new Error("unique violation"), {
                    code: "23505",
                    constraint: "uq_kyc_records_verified_national_id",
                });
            }
            return { rows: [] };
        },
        release() {},
    });
    const res = response();
    await reviewSubmission({
        params: { kycId: "kyc-2" },
        body: { status: "VERIFIED" },
        user: { userId: "admin-1" },
    }, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "KYC_NATIONAL_ID_ALREADY_VERIFIED");
    assert.doesNotMatch(JSON.stringify(res.body), /12345678|worker-1|uq_kyc_records/);
    assert.ok(statements.includes("ROLLBACK"));
    assert.equal(statements.includes("COMMIT"), false);
});
