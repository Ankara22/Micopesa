const express = require("express");
const { getComplianceOverview, listReports } = require("../controllers/regulatorController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireAuth, requireRole("REGULATOR"));
router.get("/compliance", getComplianceOverview);
router.get("/reports", listReports);

module.exports = router;
