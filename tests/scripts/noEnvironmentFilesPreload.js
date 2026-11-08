const Module = require("node:module");

if (process.env.MICOPESA_TEST_DOTENV_STUB !== "enabled") {
    throw new Error("Environment-file test isolation is not enabled.");
}

global.__micopesaDotenvConfigCalls = 0;
const originalLoad = Module._load;
Module._load = function loadWithDotenvStub(request, parent, isMain) {
    if (request === "dotenv") {
        return {
            config() {
                global.__micopesaDotenvConfigCalls += 1;
                return { parsed: {} };
            },
        };
    }
    return originalLoad.call(this, request, parent, isMain);
};
