const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repositoryRoot = path.resolve(__dirname, "../..");
const apiTestsDirectory = path.join(repositoryRoot, "apps", "api", "tests");
const excludedTests = new Set([
    "regression.test.js",
    "withdrawalPostgres.integration.test.js",
    "kycUniquenessPostgres.integration.test.js",
]);

const testFiles = fs.readdirSync(apiTestsDirectory)
    .filter((name) => name.endsWith(".test.js") && !excludedTests.has(name))
    .sort()
    .map((name) => path.join(apiTestsDirectory, name));

if (testFiles.length === 0) {
    console.error("No API unit tests were found.");
    process.exitCode = 1;
} else {
    const coverage = process.argv.includes("--coverage");
    const nodeArgs = [
        "--require",
        path.join(__dirname, "unitTestBootstrap.js"),
        "--test",
    ];
    if (coverage) nodeArgs.push("--experimental-test-coverage");
    nodeArgs.push(...testFiles);

    const result = spawnSync(process.execPath, nodeArgs, {
        cwd: repositoryRoot,
        env: { ...process.env, NODE_ENV: "test" },
        stdio: "inherit",
    });
    if (result.error) {
        console.error(result.error.message);
        process.exitCode = 1;
    } else {
        process.exitCode = result.status === null ? 1 : result.status;
    }
}
