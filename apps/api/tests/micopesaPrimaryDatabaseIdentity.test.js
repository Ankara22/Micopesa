const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    isLoopbackAddress,
    verifyMicopesaDatabaseIdentity,
} = require("../../../tests/scripts/micopesaPrimaryDatabaseIdentity");

const acceptedLoopbackAddresses = [
    "127.0.0.1",
    "127.0.0.2",
    "127.255.255.255",
    "127.0.0.1/32",
    "::1",
    "::1/128",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:127.255.255.255",
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
];

const rejectedAddresses = [
    null,
    undefined,
    "",
    "unknown",
    "127.0.0.1/33",
    "::1/129",
    "::1/not-a-prefix",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "203.0.113.1",
    "::2",
    "fc00::1",
    "fe80::1",
    "::ffff:10.0.0.1",
    "::ffff:c0a8:101",
    "::ffff:cb00:7101",
];

function clientFor(row) {
    const queries = [];
    return {
        queries,
        client: {
            async query(query) {
                queries.push(query);
                return { rows: row ? [row] : [] };
            },
        },
    };
}

test("classifies IPv4, IPv6, and dotted or hexadecimal IPv4-mapped loopback addresses", () => {
    for (const address of acceptedLoopbackAddresses) {
        assert.equal(isLoopbackAddress(address), true, `Expected loopback address: ${address}`);
    }
});

test("rejects private, public, malformed, null, and unknown addresses", () => {
    for (const address of rejectedAddresses) {
        assert.equal(isLoopbackAddress(address), false, `Expected rejected address: ${address}`);
    }
});

test("verifies the primary Micopesa database, required port, and server loopback address", async () => {
    for (const serverAddress of acceptedLoopbackAddresses) {
        const { client, queries } = clientFor({
            database_name: "Micopesa",
            server_port: 5433,
            server_address: serverAddress,
        });

        assert.equal(await verifyMicopesaDatabaseIdentity(client), true);
        assert.equal(queries.length, 1);
        assert.match(queries[0], /current_database\(\)/);
        assert.match(queries[0], /inet_server_port\(\)/);
        assert.match(queries[0], /inet_server_addr\(\)/);
    }
});

test("rejects any database other than the primary Micopesa database", async () => {
    for (const databaseName of ["Micopesa_migration_validation", "micopesa_test", "micopesa"]) {
        const { client } = clientFor({
            database_name: databaseName,
            server_port: 5433,
            server_address: "::1",
        });
        await assert.rejects(verifyMicopesaDatabaseIdentity(client), {
            code: "MICOPESA_IDENTITY_WRONG_DATABASE",
        });
    }
});

test("rejects any PostgreSQL port other than 5433", async () => {
    for (const serverPort of [5432, 5544, null]) {
        const { client } = clientFor({
            database_name: "Micopesa",
            server_port: serverPort,
            server_address: "127.0.0.1",
        });
        await assert.rejects(verifyMicopesaDatabaseIdentity(client), {
            code: "MICOPESA_IDENTITY_WRONG_PORT",
        });
    }
});

test("rejects missing identity rows and non-loopback server addresses", async () => {
    const emptyResult = clientFor(null);
    await assert.rejects(verifyMicopesaDatabaseIdentity(emptyResult.client), {
        code: "MICOPESA_IDENTITY_WRONG_DATABASE",
    });

    for (const serverAddress of rejectedAddresses) {
        const { client } = clientFor({
            database_name: "Micopesa",
            server_port: 5433,
            server_address: serverAddress,
        });
        await assert.rejects(verifyMicopesaDatabaseIdentity(client), {
            code: "MICOPESA_IDENTITY_WRONG_SERVER_ADDRESS",
        });
    }
});
