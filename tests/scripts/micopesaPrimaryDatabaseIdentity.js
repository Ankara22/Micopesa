const { isIP } = require("node:net");

const PRIMARY_DATABASE = "Micopesa";
const PRIMARY_PORT = 5433;

function parseIPv6Words(address) {
    let normalized = address;
    if (normalized.includes(".")) {
        const lastColon = normalized.lastIndexOf(":");
        const embeddedIPv4 = normalized.slice(lastColon + 1);
        if (isIP(embeddedIPv4) !== 4) return null;

        const octets = embeddedIPv4.split(".").map(Number);
        const highWord = ((octets[0] << 8) | octets[1]).toString(16);
        const lowWord = ((octets[2] << 8) | octets[3]).toString(16);
        normalized = `${normalized.slice(0, lastColon + 1)}${highWord}:${lowWord}`;
    }

    const sections = normalized.split("::");
    if (sections.length > 2) return null;
    const left = sections[0] ? sections[0].split(":") : [];
    const right = sections.length === 2 && sections[1] ? sections[1].split(":") : [];
    const omittedWords = 8 - left.length - right.length;
    if (
        (sections.length === 1 && omittedWords !== 0) ||
        (sections.length === 2 && omittedWords < 1)
    ) {
        return null;
    }

    const words = [
        ...left,
        ...Array(omittedWords).fill("0"),
        ...right,
    ].map((word) => Number.parseInt(word, 16));
    return words.length === 8 &&
        words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
        ? words
        : null;
}

function isLoopbackAddress(address) {
    if (typeof address !== "string" || !address.trim()) return false;

    const [addressPart, prefix, ...extraParts] = address.trim().split("/");
    if (extraParts.length > 0) return false;

    const zoneParts = addressPart.split("%");
    if (zoneParts.length > 2 || (zoneParts.length === 2 && !zoneParts[1])) return false;
    const normalized = zoneParts[0].toLowerCase();
    const family = isIP(normalized);
    if (
        family === 0 ||
        (zoneParts.length === 2 && family !== 6) ||
        (prefix !== undefined &&
            (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))
    ) {
        return false;
    }

    if (family === 4) {
        return Number(normalized.split(".")[0]) === 127;
    }

    const words = parseIPv6Words(normalized);
    if (!words) return false;

    const isIPv6Loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
    if (isIPv6Loopback) return true;

    const isIPv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    return isIPv4Mapped && (words[6] >>> 8) === 127;
}

function identityError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

async function verifyMicopesaDatabaseIdentity(client) {
    const result = await client.query(
        `SELECT current_database() AS database_name,
                inet_server_port() AS server_port,
                inet_server_addr()::text AS server_address`
    );
    const identity = result.rows?.[0];
    if (!identity || identity.database_name !== PRIMARY_DATABASE) {
        throw identityError(
            "MICOPESA_IDENTITY_WRONG_DATABASE",
            "Connected database identity did not match Micopesa."
        );
    }
    if (Number(identity.server_port) !== PRIMARY_PORT) {
        throw identityError(
            "MICOPESA_IDENTITY_WRONG_PORT",
            "Connected PostgreSQL server did not report port 5433."
        );
    }
    if (!isLoopbackAddress(identity.server_address)) {
        throw identityError(
            "MICOPESA_IDENTITY_WRONG_SERVER_ADDRESS",
            "Connected PostgreSQL server did not report a loopback address."
        );
    }
    return true;
}

module.exports = {
    isLoopbackAddress,
    verifyMicopesaDatabaseIdentity,
};
