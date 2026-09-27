const express = require("express");
const { listOperationalLogs, listSystemLogs } = require("../controllers/auditLogController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/operational", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), listOperationalLogs);
router.get("/system", requireAuth, requireRole("ADMIN"), listSystemLogs);

module.exports = router;
