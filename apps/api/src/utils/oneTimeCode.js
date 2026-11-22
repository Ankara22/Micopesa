const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SCRYPT_OPTIONS = {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
};

function generateSixDigitCode() {
    return crypto.randomInt(0, 1000000).toString().padStart(6, "0");
}

async function hashOneTimeCode(code) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const hash = await scrypt(code, salt, HASH_BYTES, SCRYPT_OPTIONS);
    return { salt, hash };
}

async function verifyOneTimeCode(code, salt, expectedHash) {
    if (!Buffer.isBuffer(salt) || !Buffer.isBuffer(expectedHash) ||
        expectedHash.length !== HASH_BYTES) {
        return false;
    }
    const actualHash = await scrypt(code, salt, HASH_BYTES, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(expectedHash, actualHash);
}

module.exports = {
    generateSixDigitCode,
    hashOneTimeCode,
    verifyOneTimeCode,
};
