const express = require("express");
const { createReport, listReports, getReport } = require("../controllers/complianceReportController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), createReport);
router.get("/", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), listReports);
router.get("/:reportId", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), getReport);

module.exports = router;
