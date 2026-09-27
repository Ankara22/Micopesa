const express = require("express");
const {
    createFund,
    listFunds,
    getFund,
    updateFund,
    getFundAllocations,
} = require("../controllers/fundController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", requireAuth, requireRole("FUND_MANAGER"), createFund);
router.get("/", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), listFunds);
router.get("/:fundId", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), getFund);
router.patch("/:fundId", requireAuth, requireRole("FUND_MANAGER"), updateFund);
router.get("/:fundId/allocations", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), getFundAllocations);

module.exports = router;
