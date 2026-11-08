const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const {
    getTargetDatabase,
    verifyDatabaseIdentity,
} = require("./testDatabaseSafety");

const repositoryRoot = path.resolve(__dirname, "../..");
const apiTestsDirectory = path.join(repositoryRoot, "apps", "api", "tests");
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const { Client } = apiRequire("pg");

function resolveTestFiles(argumentsList) {
    if (argumentsList.length === 0) {
        throw new Error("Select one or more API integration test files.");
    }

    return argumentsList.map((argument) => {
        const absolutePath = path.resolve(repositoryRoot, argument);
        const relativePath = path.relative(apiTestsDirectory, absolutePath);
        if (
            relativePath.startsWith("..") ||
            path.isAbsolute(relativePath) ||
            !relativePath.endsWith(".test.js")
        ) {
            throw new Error("Integration tests must be selected from apps/api/tests as .test.js files.");
        }
        return absolutePath;
    });
}

async function main(argumentsList = process.argv.slice(2), environment = process.env) {
    const testFiles = resolveTestFiles(argumentsList);
    const target = getTargetDatabase(environment);
    const client = new Client({ connectionString: target.url.toString() });
    await client.connect();
    try {
        await verifyDatabaseIdentity(client, target.databaseName);
    } finally {
        await client.end();
    }

    const result = spawnSync(process.execPath, ["--test", ...testFiles], {
        cwd: repositoryRoot,
        env: {
            ...environment,
            NODE_ENV: "test",
            DATABASE_URL: target.url.toString(),
        },
        stdio: "inherit",
    });
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status === null ? 1 : result.status;
}

if (require.main === module) {
    main().then((status) => {
        process.exitCode = status;
    }).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { main, resolveTestFiles };
