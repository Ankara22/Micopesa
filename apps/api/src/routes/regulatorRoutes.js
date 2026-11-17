const express = require("express");
const {
    getComplianceOverview,
    getDashboardOverview,
    getKycOversight,
    getInternalControlChecks,
    listReports,
    getComplianceReport,
    reviewComplianceReport,
} = require("../controllers/regulatorController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireAuth, requireRole("REGULATOR"));
router.get("/dashboard", getDashboardOverview);
router.get("/compliance", getComplianceOverview);
router.get("/kyc-oversight", getKycOversight);
router.get("/internal-control-checks", getInternalControlChecks);
router.get("/reports", listReports);
router.get("/reports/:reportId", getComplianceReport);
router.post("/reports/:reportId/review", reviewComplianceReport);

module.exports = router;
