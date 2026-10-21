const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const { startStkPush, getStkPushStatus, handleStkCallback } = require("../controllers/mpesaController");

const router = express.Router();

router.post("/stkpush", requireAuth, requireRole("WORKER"), startStkPush);
router.post("/callback", handleStkCallback);
router.get("/status/:checkoutRequestId", requireAuth, requireRole("WORKER"), getStkPushStatus);

module.exports = router;
