const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const { createMobileSasaDlrIngress } = require("../middleware/mobileSasaDlrIngress");
const {
    receiveDeliveryReport,
    replayUnmatched,
} = require("../controllers/mobileSasaDlrController");

const router = express.Router();

router.post("/delivery-reports", createMobileSasaDlrIngress(), receiveDeliveryReport);
router.post(
    "/delivery-reports/replay",
    requireAuth,
    requireRole("ADMIN"),
    replayUnmatched
);

module.exports = router;
