const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    decryptNationalId,
    encryptNationalId,
    fingerprintNationalId,
    getNationalIdKeys,
} = require("../src/services/nationalIdCrypto");

const environment = {
    NATIONAL_ID_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    NATIONAL_ID_FINGERPRINT_KEY: Buffer.alloc(32, 2).toString("base64"),
};

test("National IDs encrypt and decrypt with authenticated ciphertext and deterministic fingerprints", () => {
    const first = encryptNationalId("00123456", { environment });
    const second = encryptNationalId("00123456", { environment });

    assert.equal(decryptNationalId(first, { environment }), "00123456");
    assert.notDeepEqual(first.iv, second.iv);
    assert.notDeepEqual(first.ciphertext, second.ciphertext);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(first.lastFour, "3456");
    assert.equal(first.ciphertext.includes(Buffer.from("00123456")), false);
    assert.equal(fingerprintNationalId("00123456", { environment }), first.fingerprint);
});

test("National ID decryption rejects tampered ciphertext and invalid cryptographic keys", () => {
    const encrypted = encryptNationalId("12345678", { environment });
    encrypted.tag[0] ^= 0xff;
    assert.throws(
        () => decryptNationalId(encrypted, { environment }),
        { code: "NATIONAL_ID_CIPHERTEXT_INVALID" },
    );

    assert.throws(
        () => getNationalIdKeys({
            NATIONAL_ID_ENCRYPTION_KEY: environment.NATIONAL_ID_ENCRYPTION_KEY,
            NATIONAL_ID_FINGERPRINT_KEY: environment.NATIONAL_ID_ENCRYPTION_KEY,
        }),
        { code: "NATIONAL_ID_CRYPTO_CONFIGURATION_INVALID" },
    );
});

test("different National IDs use different fingerprints and tampered nonces are rejected", () => {
    const first = encryptNationalId("12345678", { environment });
    const second = encryptNationalId("87654321", { environment });
    assert.notEqual(first.fingerprint, second.fingerprint);
    assert.equal(
        fingerprintNationalId("12345678", { environment }),
        first.fingerprint,
    );
    assert.equal(first.keyVersion, "v1");

    first.iv[0] ^= 0xff;
    assert.throws(
        () => decryptNationalId(first, { environment }),
        { code: "NATIONAL_ID_CIPHERTEXT_INVALID" },
    );

    const unsupported = encryptNationalId("12345678", { environment });
    unsupported.keyVersion = "v2";
    assert.throws(
        () => decryptNationalId(unsupported, { environment }),
        { code: "NATIONAL_ID_KEY_VERSION_UNSUPPORTED" },
    );
});

test("missing encryption and fingerprint keys are reported separately", () => {
    assert.throws(
        () => getNationalIdKeys({ NATIONAL_ID_FINGERPRINT_KEY: environment.NATIONAL_ID_FINGERPRINT_KEY }),
        (error) => error.code === "NATIONAL_ID_CRYPTO_CONFIGURATION_MISSING"
            && error.configurationVariables.includes("NATIONAL_ID_ENCRYPTION_KEY"),
    );
    assert.throws(
        () => getNationalIdKeys({ NATIONAL_ID_ENCRYPTION_KEY: environment.NATIONAL_ID_ENCRYPTION_KEY }),
        (error) => error.code === "NATIONAL_ID_CRYPTO_CONFIGURATION_MISSING"
            && error.configurationVariables.includes("NATIONAL_ID_FINGERPRINT_KEY"),
    );
});
