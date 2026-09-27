const express = require("express");
const { listSessions, getActivitySummary } = require("../controllers/activityController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/sessions", requireAuth, requireRole("ADMIN"), listSessions);
router.get("/summary", requireAuth, requireRole("ADMIN"), getActivitySummary);

module.exports = router;
