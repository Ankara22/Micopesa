const { afterEach, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const pool = require("../src/db/database");
const controller = require("../src/controllers/profileController");
const { validateImageContent } = require("../src/services/profilePhotoStorage");
const authEmailService = require("../src/services/authEmailService");

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originalEnforceRequestLimits = authEmailService.enforceRequestLimits;
const originalIssueEmailToken = authEmailService.issueEmailToken;
const originalLogEmailDeliveryFailure = authEmailService.logEmailDeliveryFailure;
const originalStorageDirectory = process.env.PROFILE_PHOTO_STORAGE_DIR;
const originalNodeEnv = process.env.NODE_ENV;
const userId = "authenticated-user";
const temporaryDirectories = [];

function createResponse() {
    return {
        statusCode: null,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        set(headers) {
            Object.assign(this.headers, headers);
            return this;
        },
        end(body) {
            this.rawBody = body;
            return this;
        },
    };
}

function createRequest(body, extra = {}) {
    return { user: { userId, role: "WORKER" }, body, headers: {}, ...extra };
}

function profileRecord(overrides = {}) {
    return {
        user_id: userId,
        full_name: "Amina Worker",
        email: "worker@example.test",
        role: "WORKER",
        date_of_birth: "1990-04-15",
        national_id_last_four: "1234",
        kyc_status: "PENDING",
        ...overrides,
    };
}

async function useTempPhotoDirectory() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "micopesa-profile-test-"));
    temporaryDirectories.push(directory);
    process.env.PROFILE_PHOTO_STORAGE_DIR = directory;
    return directory;
}

async function createImage(format, width = 4, height = 4) {
    const image = sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 20, g: 120, b: 80, alpha: 1 },
        },
    });
    return image[format]().toBuffer();
}

afterEach(async () => {
    pool.query = originalQuery;
    pool.connect = originalConnect;
    authEmailService.enforceRequestLimits = originalEnforceRequestLimits;
    authEmailService.issueEmailToken = originalIssueEmailToken;
    authEmailService.logEmailDeliveryFailure = originalLogEmailDeliveryFailure;
    if (originalStorageDirectory === undefined) delete process.env.PROFILE_PHOTO_STORAGE_DIR;
    else process.env.PROFILE_PHOTO_STORAGE_DIR = originalStorageDirectory;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ));
});

test("returns only the authenticated user's KYC fields with a masked National ID", async () => {
    let queryText;
    let queryValues;
    pool.query = async (query, values) => {
        queryText = query;
        queryValues = values;
        return { rows: [{
            user_id: userId,
            full_name: "Amina Worker",
            role: "WORKER",
            phone_verified: true,
            phone_verified_at: new Date("2026-11-05T12:00:00Z"),
            date_of_birth: "1990-04-15",
            national_id_last_four: "1234",
            kyc_status: "PENDING",
        }] };
    };

    const res = createResponse();
    await controller.getMyProfile(createRequest(
        { user_id: "another-user" },
        { params: { userId: "another-user" }, query: { userId: "another-user" } }
    ), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(queryValues, [userId]);
    assert.match(queryText, /LEFT JOIN kyc_records kyc ON kyc\.user_id = users\.user_id/);
    assert.match(queryText, /phone_verified_at IS NOT NULL\) AS phone_verified/i);
    assert.match(queryText, /right\(kyc\.national_id, 4\) AS national_id_last_four/i);
    assert.doesNotMatch(queryText, /(?:^|,)\s*kyc\.national_id\s*(?:,|FROM)/i);
    assert.equal(res.body.data.user.date_of_birth, "1990-04-15");
    assert.equal(res.body.data.user.phone_verified, true);
    assert.equal(res.body.data.user.masked_national_id, "****1234");
    assert.equal(res.body.data.user.kyc_status, "PENDING");
    assert.equal(Object.hasOwn(res.body.data.user, "national_id"), false);
    assert.equal(Object.hasOwn(res.body.data.user, "duplicate_submission"), false);
});

test("profile retrieval remains successful when the authenticated user has no KYC record", async () => {
    pool.query = async (_query, values) => {
        assert.deepEqual(values, [userId]);
        return { rows: [{
            user_id: userId,
            full_name: "Legacy Worker",
            role: "WORKER",
            date_of_birth: null,
            masked_national_id: null,
            kyc_status: null,
        }] };
    };
    const res = createResponse();
    await controller.getMyProfile(createRequest(null), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.user.full_name, "Legacy Worker");
    assert.equal(res.body.data.user.date_of_birth, null);
    assert.equal(res.body.data.user.masked_national_id, null);
    assert.equal(res.body.data.user.kyc_status, null);
});

test("updates name and stores a normalized new email as pending until verified", async () => {
    let queryText;
    let queryValues;
    const calls = [];
    pool.query = async (query, values) => {
        calls.push({ query, values });
        if (query.includes("SELECT user_id FROM users")) return { rows: [] };
        if (query.startsWith("UPDATE users")) {
            queryText = query;
            queryValues = values;
            return { rows: [{ user_id: userId }] };
        }
        assert.match(query, /LEFT JOIN kyc_records kyc/);
        return { rows: [profileRecord({
            full_name: "Amina Wanjiku",
            email: null,
            pending_email: "amina@example.com",
            email_verified: false,
        })] };
    };
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async () => {};

    const res = createResponse();
    await controller.updateMyProfile(
        createRequest({ full_name: "  Amina Wanjiku ", email: " AMINA@Example.COM " }),
        res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(queryValues, ["Amina Wanjiku", "amina@example.com", userId]);
    assert.match(queryText, /WHERE user_id = \$3/);
    assert.match(queryText, /SET full_name = \$1, pending_email = \$2/);
    assert.match(queryText, /RETURNING users\.user_id/);
    assert.doesNotMatch(queryText, /kyc\./i);
    assert.doesNotMatch(queryText, /SET[^]*role\s*=/i);
    assert.equal(res.body.data.user.role, "WORKER");
    assert.equal(res.body.data.user.email_verified, false);
    assert.equal(res.body.data.user.kyc_status, "PENDING");
    assert.equal(res.body.data.user.masked_national_id, "****1234");
    assert.equal(Object.hasOwn(res.body.data.user, "national_id"), false);
    assert.ok(calls.some(({ query }) => query.includes("pending_email")));
});

test("keeps a failed SMTP email change pending and reports that verification was not sent", async () => {
    let updateValues;
    const logged = [];
    pool.query = async (query, values) => {
        if (query.includes("SELECT user_id FROM users")) return { rows: [] };
        if (query.startsWith("UPDATE users")) {
            updateValues = values;
            return { rows: [{ user_id: userId }] };
        }
        return { rows: [profileRecord({
            full_name: "Amina Wanjiku",
            email: null,
            pending_email: "amina@example.com",
            email_verified: false,
        })] };
    };
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async () => {
        throw Object.assign(new Error("SMTP delivery failed"), {
            code: "EMAIL_SMTP_DELIVERY_FAILED",
            smtpCode: "EAUTH",
            responseCode: 535,
        });
    };
    authEmailService.logEmailDeliveryFailure = (purpose, error) => logged.push([purpose, error.smtpCode]);

    const res = createResponse();
    await controller.updateMyProfile(
        createRequest({ full_name: "Amina Wanjiku", email: "AMINA@example.com" }),
        res
    );

    assert.equal(res.statusCode, 503);
    assert.match(res.body.message, /saved as pending, but verification could not be sent/i);
    assert.equal(updateValues[1], "amina@example.com");
    assert.deepEqual(logged, [["EMAIL_VERIFICATION", "EAUTH"]]);
});

test("updates Bradley Omondi Juma without requiring or changing the email", async () => {
    let queryText;
    let queryValues;
    pool.query = async (query, values) => {
        if (query.startsWith("UPDATE users")) {
            queryText = query;
            queryValues = values;
            return { rows: [{ user_id: userId }] };
        }
        return { rows: [profileRecord({
            full_name: "Bradley Omondi Juma",
            email: "unchanged@example.com",
        })] };
    };

    const res = createResponse();
    await controller.updateMyProfile(
        createRequest({ full_name: "  Bradley Omondi Juma " }),
        res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(queryValues, ["Bradley Omondi Juma", userId]);
    assert.match(queryText, /SET full_name = \$1/);
    assert.doesNotMatch(queryText, /email\s*=/i);
    assert.equal(res.body.data.user.email, "unchanged@example.com");
});

for (const name of [
    "Amina O'Connor",
    "Anne-Marie Smith",
    "J. R. R. Tolkien",
    "José Muñoz",
    "Jose\u0301 Mun\u0303oz",
    "Amina\u00a0Wanjiku",
]) {
    test(`accepts a legitimate full name: ${JSON.stringify(name)}`, async () => {
        let queryValues;
        pool.query = async (_query, values) => {
            if (_query.startsWith("UPDATE users")) {
                queryValues = values;
                return { rows: [{ user_id: userId }] };
            }
            return { rows: [profileRecord({ full_name: queryValues[0] })] };
        };
        const res = createResponse();
        await controller.updateMyProfile(createRequest({ full_name: name }), res);
        assert.equal(res.statusCode, 200);
        assert.equal(queryValues[0], name === "Jose\u0301 Mun\u0303oz" ? "José Muñoz" : name.replace("\u00a0", " "));
    });
}

test("saves a normalized email for verification without changing the existing email", async () => {
    let queryText;
    let queryValues;
    pool.query = async (query, values) => {
        if (query.includes("SELECT user_id FROM users")) return { rows: [] };
        if (query.startsWith("UPDATE users")) {
            queryText = query;
            queryValues = values;
            return { rows: [{ user_id: userId }] };
        }
        return { rows: [profileRecord({
            full_name: "Amina O'Connor-Smith",
            email: "old@example.com",
            pending_email: "amina@example.com",
            email_verified: false,
        })] };
    };
    authEmailService.enforceRequestLimits = async () => {};
    authEmailService.issueEmailToken = async () => {};

    const res = createResponse();
    await controller.updateMyProfile(
        createRequest({ email: " AMINA@Example.COM " }),
        res
    );

    assert.equal(res.statusCode, 200);
    assert.deepEqual(queryValues, ["amina@example.com", userId]);
    assert.match(queryText, /SET pending_email = \$1/);
    assert.doesNotMatch(queryText, /full_name\s*=/i);
    assert.equal(res.body.data.user.full_name, "Amina O'Connor-Smith");
    assert.equal(res.body.data.user.email, "old@example.com");
    assert.equal(res.body.data.user.email_verified, false);
});

for (const body of [
    { full_name: " " },
    { full_name: "A" },
    { full_name: "Amina 42" },
    { full_name: "A".repeat(101) },
    { full_name: "Amina\nWanjiku" },
    { full_name: "Amina\tWanjiku" },
    { full_name: "Amina !" },
    { email: "not-an-email" },
]) {
    test(`rejects invalid profile fields: ${JSON.stringify(body)}`, async () => {
        pool.query = async () => assert.fail("Invalid profiles must not reach the database");
        const res = createResponse();
        await controller.updateMyProfile(createRequest(body), res);
        assert.equal(res.statusCode, 400);
        assert.match(
            res.body.message,
            Object.prototype.hasOwnProperty.call(body, "full_name") ? /Full name must be/ : /valid email address/
        );
    });
}

test("rejects duplicate normalized email addresses", async () => {
    pool.query = async () => { throw { code: "23505" }; };
    const res = createResponse();
    await controller.updateMyProfile(
        createRequest({ full_name: "Amina Worker", email: "taken@example.com" }),
        res
    );
    assert.equal(res.statusCode, 409);
    assert.match(res.body.message, /already in use/i);
});

test("rejects privilege fields and attempted cross-user profile identifiers", async () => {
    pool.query = async () => assert.fail("Unapproved profile fields must not reach the database");
    for (const body of [
        { full_name: "Amina Worker", email: "a@example.com", role: "ADMIN" },
        { full_name: "Amina Worker", email: "a@example.com", account_status: "ACTIVE" },
        { full_name: "Amina Worker", email: "a@example.com", permissions: ["admin"] },
        { full_name: "Amina Worker", email: "a@example.com", user_id: "another-user" },
        { full_name: "Amina Worker", password: "new-password" },
        { full_name: "Amina Worker", phone: "254711111111" },
        { full_name: "Amina Worker", balance: 100 },
    ]) {
        const res = createResponse();
        await controller.updateMyProfile(createRequest(body), res);
        assert.equal(res.statusCode, 400);
    }
});

test("photo upload validates content, uses an opaque server reference, and serves only the current user's photo", async () => {
    const directory = await useTempPhotoDirectory();
    const png = await createImage("png");
    let photoReference = null;
    pool.connect = async () => ({
        async query(query, values) {
            if (query === "COMMIT" || query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
            if (query === "SELECT profile_photo_ref FROM users WHERE user_id = $1 FOR UPDATE") {
                assert.deepEqual(values, [userId]);
                return { rows: [{ profile_photo_ref: null }] };
            }
            if (query.startsWith("UPDATE users")) {
                assert.match(query, /WHERE user_id = \$2/);
                assert.match(query, /RETURNING users\.user_id/);
                assert.doesNotMatch(query, /kyc\./i);
                assert.equal(values[1], userId);
                photoReference = values[0];
                return { rows: [{ user_id: userId }] };
            }
            assert.match(query, /LEFT JOIN kyc_records kyc/);
            assert.match(query, /right\(kyc\.national_id, 4\) AS national_id_last_four/i);
            assert.doesNotMatch(query, /(?:^|,)\s*kyc\.national_id\s*(?:,|FROM)/i);
            return { rows: [profileRecord({ profile_photo_available: true })] };
        },
        release() {},
    });

    const uploadRes = createResponse();
    await controller.uploadMyProfilePhoto(createRequest(png, {
        headers: { "content-type": "image/png" },
    }), uploadRes);
    assert.equal(uploadRes.statusCode, 200);
    assert.equal(uploadRes.body.data.user.kyc_status, "PENDING");
    assert.equal(uploadRes.body.data.user.masked_national_id, "****1234");
    assert.equal(Object.hasOwn(uploadRes.body.data.user, "national_id"), false);
    assert.match(photoReference, /^[a-f0-9]{32}\.png$/);
    assert.deepEqual(await fs.readFile(path.join(directory, photoReference)), png);

    pool.query = async (query, values) => {
        assert.equal(query, "SELECT profile_photo_ref FROM users WHERE user_id = $1");
        assert.deepEqual(values, [userId]);
        return { rows: [{ profile_photo_ref: photoReference }] };
    };
    const photoRes = createResponse();
    await controller.getMyProfilePhoto(createRequest(null), photoRes);
    assert.equal(photoRes.statusCode, 200);
    assert.equal(photoRes.headers["Content-Type"], "image/png");
    assert.equal(photoRes.headers["X-Content-Type-Options"], "nosniff");
    assert.deepEqual(photoRes.rawBody, png);
});

test("replacing a photo removes only the current user's prior generated file", async () => {
    const directory = await useTempPhotoDirectory();
    const previousRef = `${"a".repeat(32)}.png`;
    const previousPhoto = await createImage("png");
    await fs.writeFile(path.join(directory, previousRef), previousPhoto);
    const newPhoto = await createImage("webp");
    let newRef;
    pool.connect = async () => ({
        async query(query, values) {
            if (query === "COMMIT" || query === "BEGIN" || query === "ROLLBACK") return { rows: [] };
            if (query === "SELECT profile_photo_ref FROM users WHERE user_id = $1 FOR UPDATE") {
                assert.deepEqual(values, [userId]);
                return { rows: [{ profile_photo_ref: previousRef }] };
            }
            if (query.startsWith("UPDATE users")) {
                newRef = values[0];
                return { rows: [{ user_id: userId }] };
            }
            if (query.includes("LEFT JOIN kyc_records")) {
                return { rows: [profileRecord({ profile_photo_available: true })] };
            }
            return { rows: [] };
        },
        release() {},
    });

    const res = createResponse();
    await controller.uploadMyProfilePhoto(createRequest(newPhoto, {
        headers: { "content-type": "image/webp" },
    }), res);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(res.statusCode, 200);
    await assert.rejects(fs.access(path.join(directory, previousRef)));
    assert.deepEqual(await fs.readFile(path.join(directory, newRef)), newPhoto);
});

test("rejects invalid, mismatched, and oversized photo uploads", async () => {
    await useTempPhotoDirectory();
    pool.query = async () => assert.fail("Invalid photos must not update the database");
    const validPng = await createImage("png");
    const truncatedPng = validPng.subarray(0, validPng.length - 8);
    const oversizedDimensions = await createImage("png", 4097, 1);

    for (const [bytes, contentType, expectedStatus] of [
        [Buffer.from("not an image"), "image/png", 415],
        [validPng, "image/webp", 415],
        [truncatedPng, "image/png", 415],
        [oversizedDimensions, "image/png", 415],
        [Buffer.alloc(5 * 1024 * 1024 + 1), "image/png", 413],
    ]) {
        const res = createResponse();
        await controller.uploadMyProfilePhoto(createRequest(bytes, {
            headers: { "content-type": contentType },
        }), res);
        assert.equal(res.statusCode, expectedStatus);
    }
});

test("fully decodes valid JPEG, PNG, and WebP images", async () => {
    for (const [format, contentType] of [
        ["jpeg", "image/jpeg"],
        ["png", "image/png"],
        ["webp", "image/webp"],
    ]) {
        await validateImageContent(await createImage(format), contentType);
    }
});

test("reports users without a photo using 404", async () => {
    pool.query = async () => ({ rows: [{ profile_photo_ref: null }] });
    const res = createResponse();
    await controller.getMyProfilePhoto(createRequest(null), res);
    assert.equal(res.statusCode, 404);
});

test("rolls back a failed photo database update and removes its unreferenced file", async () => {
    const directory = await useTempPhotoDirectory();
    const png = await createImage("png");
    let rolledBack = false;
    pool.connect = async () => ({
        async query(query) {
            if (query === "BEGIN") return { rows: [] };
            if (query === "SELECT profile_photo_ref FROM users WHERE user_id = $1 FOR UPDATE") {
                return { rows: [{ profile_photo_ref: null }] };
            }
            if (query.startsWith("UPDATE users")) throw new Error("database write failed");
            if (query === "ROLLBACK") {
                rolledBack = true;
                return { rows: [] };
            }
            return { rows: [] };
        },
        release() {},
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
        const res = createResponse();
        await controller.uploadMyProfilePhoto(createRequest(png, {
            headers: { "content-type": "image/png" },
        }), res);
        assert.equal(res.statusCode, 500);
        assert.equal(rolledBack, true);
        assert.deepEqual(await fs.readdir(directory), []);
    } finally {
        console.error = originalConsoleError;
    }
});

test("refuses photo writes in production without a configured persistent storage directory", async () => {
    delete process.env.PROFILE_PHOTO_STORAGE_DIR;
    process.env.NODE_ENV = "production";
    const png = await createImage("png");
    const res = createResponse();
    await controller.uploadMyProfilePhoto(createRequest(png, {
        headers: { "content-type": "image/png" },
    }), res);
    assert.equal(res.statusCode, 503);
});
