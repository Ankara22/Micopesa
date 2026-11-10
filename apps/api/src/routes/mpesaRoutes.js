const express = require("express");
const { requireAuth, requireRole, requireVerifiedKyc } = require("../middleware/authMiddleware");
const { createMpesaCallbackIngress } = require("../middleware/mpesaCallbackIngress");
const {
    startStkPush,
    getStkPushStatus,
    getStkPushStatusByIdempotencyKey,
    handleStkCallback,
    reconcileStkAttempt,
    replayUnmatchedCallbacks,
} = require("../controllers/mpesaController");
const {
    getPaymentProvider,
    initiateSimulatedPayment,
    confirmSimulatedPayment,
} = require("../controllers/mpesaSimulatorController");

const router = express.Router();

router.post("/stkpush", requireAuth, requireRole("WORKER"), startStkPush);
router.get("/provider", requireAuth, requireRole("WORKER"), requireVerifiedKyc, getPaymentProvider);
router.post("/payments", requireAuth, requireRole("WORKER"), requireVerifiedKyc, initiateSimulatedPayment);
router.post(
    "/simulator/attempts/:attemptId/confirm",
    requireAuth,
    requireRole("WORKER"),
    requireVerifiedKyc,
    confirmSimulatedPayment
);
router.post("/callback", createMpesaCallbackIngress(), handleStkCallback);
router.get(
    "/status/idempotency/:idempotencyKey",
    requireAuth,
    requireRole("WORKER"),
    requireVerifiedKyc,
    getStkPushStatusByIdempotencyKey
);
router.get("/status/:statusReference", requireAuth, requireRole("WORKER"), requireVerifiedKyc, getStkPushStatus);
router.post("/callbacks/replay", requireAuth, requireRole("ADMIN"), replayUnmatchedCallbacks);
router.post("/reconcile/:attemptId", requireAuth, requireRole("ADMIN"), reconcileStkAttempt);

module.exports = router;
