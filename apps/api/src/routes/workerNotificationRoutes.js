const express = require("express");
const { getMyNotifications } = require("../controllers/notificationController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my", requireAuth, requireRole("WORKER", "FUND_MANAGER", "REGULATOR"), getMyNotifications);

module.exports = router;