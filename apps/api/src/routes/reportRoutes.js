const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const {
    download,
    generate,
    listCatalog,
    listFunds,
    listHistory,
    analytics,
} = require("../controllers/reportController");

const router = express.Router();

router.use(requireAuth, requireRole("ADMIN", "FUND_MANAGER", "REGULATOR"));
router.get("/catalog", listCatalog);
router.get("/funds", listFunds);
router.get("/analytics", analytics);
router.post("/", generate);
router.get("/history", listHistory);
router.get("/:reportId/download", download);

module.exports = router;
