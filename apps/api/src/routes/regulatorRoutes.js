const express = require("express");
const {
    getComplianceOverview,
    listReports,
    getComplianceReport,
    reviewComplianceReport,
} = require("../controllers/regulatorController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireAuth, requireRole("REGULATOR"));
router.get("/compliance", getComplianceOverview);
router.get("/reports", listReports);
router.get("/reports/:reportId", getComplianceReport);
router.post("/reports/:reportId/review", reviewComplianceReport);

module.exports = router;
