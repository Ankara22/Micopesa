const { randomUUID } = require("node:crypto");
const { assertSimulatorRequest, getPaymentProviderConfiguration } = require("./mpesaPaymentProviderConfig");

function createMpesaSimulatorService({
    environmentProvider = () => process.env,
    idGenerator = randomUUID,
} = {}) {
    function configuration() {
        return assertSimulatorRequest("SIMULATOR", environmentProvider());
    }

    async function initiateStkPush() {
        configuration();
        const token = idGenerator().replace(/-/g, "").toUpperCase();
        return {
            checkoutRequestId: `SIM${token.slice(0, 22)}`,
            merchantRequestId: `SIMM${token.slice(0, 21)}`,
        };
    }

    async function queryStkPush({ checkoutRequestId }) {
        const current = configuration();
        if (typeof checkoutRequestId !== "string" || !/^SIM[A-F0-9]{22}$/.test(checkoutRequestId)) {
            throw new TypeError("A valid simulated payment reference is required.");
        }

        if (current.simulatorOutcome === "UNKNOWN") {
            const error = new Error("The simulated payment outcome is unknown.");
            error.code = "SIMULATOR_OUTCOME_UNKNOWN";
            throw error;
        }
        if (current.simulatorOutcome === "PENDING") {
            return {
                checkoutRequestId,
                merchantRequestId: `SIMM${checkoutRequestId.slice(3, 24)}`,
                outcomeStatus: "PENDING",
                resultCode: "0",
                resultDescription: "SIMULATED: Payment is still pending; no real money was transferred.",
            };
        }
        if (current.simulatorOutcome === "FAILED") {
            return {
                checkoutRequestId,
                merchantRequestId: `SIMM${checkoutRequestId.slice(3, 24)}`,
                resultCode: "1",
                resultDescription: "SIMULATED: Payment failed; no real money was transferred.",
            };
        }
        return {
            checkoutRequestId,
            merchantRequestId: `SIMM${checkoutRequestId.slice(3, 24)}`,
            resultCode: "0",
            resultDescription: "SIMULATED: Payment succeeded; no real money was transferred.",
        };
    }

    return {
        assertEnabled() {
            return configuration();
        },
        getConfiguration() {
            return getPaymentProviderConfiguration(environmentProvider());
        },
        initiateStkPush,
        queryStkPush,
    };
}

const defaultService = createMpesaSimulatorService();

module.exports = {
    createMpesaSimulatorService,
    initiateStkPush: (...args) => defaultService.initiateStkPush(...args),
    queryStkPush: (...args) => defaultService.queryStkPush(...args),
};
