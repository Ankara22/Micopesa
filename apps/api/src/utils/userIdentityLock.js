const { normalizeKenyanPhone } = require("./kenyanPhone");

function userIdentityLockKeys({ emails = [], phones = [], nationalIds = [] }) {
    const keys = new Set();
    for (const email of emails) {
        if (typeof email === "string" && email.trim()) {
            keys.add(`USER_EMAIL:${email.trim().toLowerCase()}`);
        }
    }
    for (const phone of phones) {
        if (typeof phone !== "string" || !phone.trim()) continue;
        const normalized = normalizeKenyanPhone(phone) ||
            phone.trim().replace(/[\s()-]/g, "");
        keys.add(`USER_PHONE:${normalized}`);
    }
    for (const fingerprint of nationalIds) {
        if (typeof fingerprint === "string" && /^[0-9a-f]{64}$/i.test(fingerprint)) {
            keys.add(`USER_NATIONAL_ID:${fingerprint.toLowerCase()}`);
        }
    }
    return [...keys].sort();
}

async function lockUserIdentities(client, identities) {
    for (const key of userIdentityLockKeys(identities)) {
        await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
            [key]
        );
    }
}

module.exports = { lockUserIdentities, userIdentityLockKeys };
