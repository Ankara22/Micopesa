import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import {
    confirmSimulatedPayment,
    getPaymentProvider,
    getStkPushStatus,
    getStkPushStatusByIdempotencyKey,
    initiateStkPush,
} from "./mpesaApi";

vi.mock("./api", () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
    },
}));

describe("M-Pesa API response handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("returns an initiation attempt only when its status contract is valid", async () => {
        const attempt = {
            attempt_id: "attempt-1",
            transaction_id: "transaction-1",
            checkout_request_id: "checkout-1",
            payment_status: "PROMPT_ACCEPTED",
            transaction_status: "PENDING",
        };
        api.post.mockResolvedValue({ data: { status: "success", data: attempt } });

        await expect(initiateStkPush({
            amount: 100,
            phoneNumber: "07000000000",
            idempotencyKey: "attempt-key-001",
        }))
            .resolves.toEqual(attempt);
        expect(api.post).toHaveBeenCalledWith("/api/mpesa/stkpush", {
            amount: 100,
            phoneNumber: "07000000000",
            idempotencyKey: "attempt-key-001",
        });
    });

    it("rejects an error-shaped or incomplete initiation response", async () => {
        api.post.mockResolvedValue({
            data: { status: "error", message: "unavailable" },
        });

        await expect(initiateStkPush({
            amount: 100,
            phoneNumber: "07000000000",
            idempotencyKey: "attempt-key-002",
        }))
            .rejects.toMatchObject({ code: "INVALID_MPESA_RESPONSE" });
    });

    it("includes the existing contribution for a deliberate payment retry", async () => {
        const attempt = {
            attempt_id: "attempt-retry",
            transaction_id: "transaction-existing",
            payment_status: "PENDING",
            transaction_status: "PENDING",
        };
        api.post.mockResolvedValue({ data: { status: "success", data: attempt } });

        await expect(initiateStkPush({
            amount: 2500,
            phoneNumber: "07000000000",
            idempotencyKey: "new-retry-key",
            contributionId: "contribution-existing",
        })).resolves.toEqual(attempt);
        expect(api.post).toHaveBeenCalledWith("/api/mpesa/stkpush", {
            amount: 2500,
            phoneNumber: "07000000000",
            idempotencyKey: "new-retry-key",
            contributionId: "contribution-existing",
        });
    });

    it("routes an explicit simulator request to its separate endpoint", async () => {
        const attempt = {
            attempt_id: "attempt-sim",
            transaction_id: "transaction-sim",
            transaction_status: "COMPLETED",
            payment_provider: "SIMULATED",
            simulated: true,
        };
        api.post.mockResolvedValue({ data: { status: "success", data: attempt } });

        await expect(initiateStkPush({
            amount: 100,
            phoneNumber: "07000000000",
            idempotencyKey: "simulated-key",
            provider: "SIMULATOR",
        })).resolves.toEqual(attempt);
        expect(api.post).toHaveBeenCalledWith("/api/mpesa/payments", {
            amount: 100,
            phoneNumber: "07000000000",
            idempotencyKey: "simulated-key",
            provider: "SIMULATOR",
        });
    });

    it("loads the server-selected payment provider", async () => {
        api.get.mockResolvedValue({
            data: {
                status: "success",
                data: { provider: "SIMULATOR", simulator_enabled: true },
            },
        });
        await expect(getPaymentProvider()).resolves.toEqual({
            provider: "SIMULATOR",
            simulator_enabled: true,
        });
        expect(api.get).toHaveBeenCalledWith("/api/mpesa/provider");
    });

    it("sends no client-supplied outcome when retrying simulator confirmation", async () => {
        api.post.mockResolvedValue({
            data: {
                status: "success",
                data: {
                    payment_provider: "SIMULATED",
                    simulated: true,
                    payment_outcome: "PENDING",
                },
            },
        });
        await expect(confirmSimulatedPayment("attempt/sim")).resolves.toMatchObject({
            payment_outcome: "PENDING",
        });
        expect(api.post).toHaveBeenCalledWith(
            "/api/mpesa/simulator/attempts/attempt%2Fsim/confirm",
            { provider: "SIMULATOR" }
        );
    });

    it("does not submit without a stable idempotency key", async () => {
        await expect(initiateStkPush({ amount: 2500, phoneNumber: "07000000000" }))
            .rejects.toThrow("A payment idempotency key is required.");
        expect(api.post).not.toHaveBeenCalled();
    });

    it("unwraps the authenticated status response and encodes its reference", async () => {
        const status = {
            attempt_id: "attempt-1",
            transaction_id: "transaction/1",
            attempt_status: "OUTCOME_UNKNOWN",
            transaction_status: "PENDING",
            contribution_status: "PENDING",
            settlement_confirmed: false,
            receipt_reference: null,
            settled_at: null,
        };
        api.get.mockResolvedValue({ data: { status: "success", data: status } });

        await expect(getStkPushStatus("checkout/1")).resolves.toEqual(status);
        expect(api.get).toHaveBeenCalledWith("/api/mpesa/status/checkout%2F1");
    });

    it("rejects status responses without both persisted payment statuses", async () => {
        api.get.mockResolvedValue({
            data: {
                status: "success",
                data: {
                    attempt_id: "attempt-1",
                    transaction_id: "transaction-1",
                    attempt_status: "PROMPT_ACCEPTED",
                    transaction_status: "PENDING",
                    settlement_confirmed: false,
                    receipt_reference: null,
                    settled_at: null,
                },
            },
        });

        await expect(getStkPushStatus("checkout-1"))
            .rejects.toMatchObject({ code: "INVALID_MPESA_RESPONSE" });
    });

    it("does not make a status request without a reference", async () => {
        await expect(getStkPushStatus(" ")).rejects.toThrow("A payment status reference is required.");
        expect(api.get).not.toHaveBeenCalled();
    });

    it("restores status with a user-scoped idempotency key", async () => {
        const status = {
            attempt_id: "attempt-1",
            transaction_id: "transaction-1",
            attempt_status: "OUTCOME_UNKNOWN",
            transaction_status: "PENDING",
            contribution_status: "PENDING",
            settlement_confirmed: false,
            receipt_reference: null,
            settled_at: null,
        };
        api.get.mockResolvedValue({ data: { status: "success", data: status } });

        await expect(getStkPushStatusByIdempotencyKey("key/with slash")).resolves.toEqual(status);
        expect(api.get).toHaveBeenCalledWith(
            "/api/mpesa/status/idempotency/key%2Fwith%20slash"
        );
    });
});
