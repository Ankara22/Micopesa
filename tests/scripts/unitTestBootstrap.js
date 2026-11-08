const path = require("node:path");
const { createRequire } = require("node:module");

process.env.NODE_ENV = "test";

const repositoryRoot = path.resolve(__dirname, "../..");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const { Client, Pool } = apiRequire("pg");
const nativeFetch = global.fetch;

function rejectDatabaseAccess() {
    const error = new Error("Database access is disabled in API unit tests.");
    error.code = "DATABASE_ACCESS_DISABLED_IN_UNIT_TEST";
    return Promise.reject(error);
}

for (const DatabaseClient of [Client, Pool]) {
    DatabaseClient.prototype.connect = rejectDatabaseAccess;
    DatabaseClient.prototype.query = rejectDatabaseAccess;
}

global.fetch = (input, ...args) => {
    let url;
    try {
        url = new URL(typeof input === "string" ? input : input.url);
    } catch {
        return Promise.reject(new Error("Invalid network request in API unit tests."));
    }

    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
        return Promise.reject(new Error("External network access is disabled in API unit tests."));
    }
    return nativeFetch(input, ...args);
};
