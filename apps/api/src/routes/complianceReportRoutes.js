const express = require("express");
const {
    listManagerReports,
    createDraft,
    updateDraft,
    submitReport,
    getManagerReport,
} = require("../controllers/complianceReportController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireAuth, requireRole("FUND_MANAGER"));
router.get("/", listManagerReports);
router.post("/", createDraft);
router.get("/:reportId", getManagerReport);
router.put("/:reportId", updateDraft);
router.post("/:reportId/submit", submitReport);

module.exports = router;
