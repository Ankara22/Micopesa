const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
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
router.get("/provider", requireAuth, requireRole("WORKER"), getPaymentProvider);
router.post("/payments", requireAuth, requireRole("WORKER"), initiateSimulatedPayment);
router.post(
    "/simulator/attempts/:attemptId/confirm",
    requireAuth,
    requireRole("WORKER"),
    confirmSimulatedPayment
);
router.post("/callback", createMpesaCallbackIngress(), handleStkCallback);
router.get(
    "/status/idempotency/:idempotencyKey",
    requireAuth,
    requireRole("WORKER"),
    getStkPushStatusByIdempotencyKey
);
router.get("/status/:statusReference", requireAuth, requireRole("WORKER"), getStkPushStatus);
router.post("/callbacks/replay", requireAuth, requireRole("ADMIN"), replayUnmatchedCallbacks);
router.post("/reconcile/:attemptId", requireAuth, requireRole("ADMIN"), reconcileStkAttempt);

module.exports = router;
