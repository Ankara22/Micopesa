const crypto = require("node:crypto");

const NATIONAL_ID_PATTERN = /^\d{7,8}$/;
const NATIONAL_ID_CONTEXT = Buffer.from("micopesa:national-id:v1", "utf8");
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;
const NATIONAL_ID_KEY_VERSION = "v1";

function createConfigurationError(code, variableNames) {
    const error = new Error("National ID cryptographic configuration is incomplete or invalid.");
    error.code = code;
    error.configurationVariables = variableNames;
    return error;
}

function readKey(environment, variableName) {
    const configured = environment[variableName];
    if (typeof configured !== "string" || !configured.trim()) {
        throw createConfigurationError("NATIONAL_ID_CRYPTO_CONFIGURATION_MISSING", [variableName]);
    }

    const value = configured.trim();
    const key = Buffer.from(value, "base64");
    if (key.length !== KEY_BYTES || key.toString("base64") !== value) {
        throw createConfigurationError("NATIONAL_ID_CRYPTO_CONFIGURATION_INVALID", [variableName]);
    }
    return key;
}

function getNationalIdKeys(environment = process.env) {
    const encryptionKey = readKey(environment, "NATIONAL_ID_ENCRYPTION_KEY");
    const fingerprintKey = readKey(environment, "NATIONAL_ID_FINGERPRINT_KEY");
    if (crypto.timingSafeEqual(encryptionKey, fingerprintKey)) {
        throw createConfigurationError(
            "NATIONAL_ID_CRYPTO_CONFIGURATION_INVALID",
            ["NATIONAL_ID_ENCRYPTION_KEY", "NATIONAL_ID_FINGERPRINT_KEY"]
        );
    }
    return { encryptionKey, fingerprintKey };
}

function normalizeNationalId(value) {
    if (typeof value !== "string") return null;
    const normalized = value.trim();
    return NATIONAL_ID_PATTERN.test(normalized) ? normalized : null;
}

function fingerprintNationalId(value, { environment = process.env, fingerprintKey } = {}) {
    const normalized = normalizeNationalId(value);
    if (!normalized) {
        const error = new TypeError("National ID must contain 7 or 8 digits.");
        error.code = "NATIONAL_ID_INVALID";
        throw error;
    }
    const key = fingerprintKey || getNationalIdKeys(environment).fingerprintKey;
    return crypto.createHmac("sha256", key)
        .update("micopesa:national-id-fingerprint:v1\0", "utf8")
        .update(normalized, "ascii")
        .digest("hex");
}

function encryptNationalId(value, { environment = process.env, encryptionKey, fingerprintKey } = {}) {
    const normalized = normalizeNationalId(value);
    if (!normalized) {
        const error = new TypeError("National ID must contain 7 or 8 digits.");
        error.code = "NATIONAL_ID_INVALID";
        throw error;
    }
    const keys = encryptionKey && fingerprintKey
        ? { encryptionKey, fingerprintKey }
        : getNationalIdKeys(environment);
    const iv = crypto.randomBytes(AES_GCM_IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", keys.encryptionKey, iv);
    cipher.setAAD(NATIONAL_ID_CONTEXT);
    const ciphertext = Buffer.concat([
        cipher.update(normalized, "utf8"),
        cipher.final(),
    ]);
    return {
        ciphertext,
        iv,
        tag: cipher.getAuthTag(),
        keyVersion: NATIONAL_ID_KEY_VERSION,
        fingerprint: fingerprintNationalId(normalized, { fingerprintKey: keys.fingerprintKey }),
        lastFour: normalized.slice(-4),
    };
}

function decryptNationalId(record, { environment = process.env, encryptionKey, fingerprintKey } = {}) {
    const keys = encryptionKey && fingerprintKey
        ? { encryptionKey, fingerprintKey }
        : getNationalIdKeys(environment);
    if (!Buffer.isBuffer(record?.ciphertext) ||
        !Buffer.isBuffer(record?.iv) ||
        record.iv.length !== AES_GCM_IV_BYTES ||
        !Buffer.isBuffer(record?.tag) ||
        record.tag.length !== AES_GCM_TAG_BYTES) {
        const error = new TypeError("Encrypted National ID data is incomplete or invalid.");
        error.code = "NATIONAL_ID_CIPHERTEXT_INVALID";
        throw error;
    }
    if (record.keyVersion !== undefined &&
        record.keyVersion !== NATIONAL_ID_KEY_VERSION) {
        const error = new TypeError("Encrypted National ID key version is unsupported.");
        error.code = "NATIONAL_ID_KEY_VERSION_UNSUPPORTED";
        throw error;
    }

    let plaintext;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", keys.encryptionKey, record.iv);
        decipher.setAAD(NATIONAL_ID_CONTEXT);
        decipher.setAuthTag(record.tag);
        plaintext = Buffer.concat([
            decipher.update(record.ciphertext),
            decipher.final(),
        ]).toString("utf8");
    } catch {
        const error = new Error("Encrypted National ID authentication failed.");
        error.code = "NATIONAL_ID_CIPHERTEXT_INVALID";
        throw error;
    }

    const normalized = normalizeNationalId(plaintext);
    const expectedFingerprint = normalized
        ? fingerprintNationalId(normalized, { fingerprintKey: keys.fingerprintKey })
        : null;
    if (!normalized ||
        expectedFingerprint !== record.fingerprint ||
        normalized.slice(-4) !== record.lastFour) {
        const error = new Error("Encrypted National ID verification failed.");
        error.code = "NATIONAL_ID_CIPHERTEXT_INVALID";
        throw error;
    }
    return normalized;
}

module.exports = {
    AES_GCM_IV_BYTES,
    AES_GCM_TAG_BYTES,
    NATIONAL_ID_PATTERN,
    NATIONAL_ID_KEY_VERSION,
    decryptNationalId,
    encryptNationalId,
    fingerprintNationalId,
    getNationalIdKeys,
    normalizeNationalId,
};
