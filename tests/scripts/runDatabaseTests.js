const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getDatabaseSetupConfig } = require("./testDatabaseSafety");
const { resolveTestFiles } = require("./runIntegrationTests");

const repositoryRoot = path.resolve(__dirname, "../..");

function runNodeScript(scriptPath, args, environment) {
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: repositoryRoot,
        env: environment,
        stdio: "inherit",
    });
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status === null ? 1 : result.status;
}

function main(argumentsList = process.argv.slice(2), environment = process.env) {
    resolveTestFiles(argumentsList);
    getDatabaseSetupConfig(environment);

    const setupStatus = runNodeScript(
        path.join(__dirname, "dbTestSetup.js"),
        [],
        environment
    );
    if (setupStatus !== 0) return setupStatus;

    return runNodeScript(
        path.join(__dirname, "runIntegrationTests.js"),
        argumentsList,
        environment
    );
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { main };
