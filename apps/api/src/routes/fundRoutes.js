const express = require("express");
const {
    createFund,
    listFunds,
    listAvailableFunds,
    getMyAllocations,
    replaceMyAllocations,
    getFund,
    updateFund,
    getFundAllocations,
} = require("../controllers/fundController");
const { requireAuth, requireRole, requireVerifiedKyc } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", requireAuth, requireRole("FUND_MANAGER"), createFund);
router.get("/", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), listFunds);
router.get("/available", requireAuth, requireRole("WORKER"), requireVerifiedKyc, listAvailableFunds);
router.get("/my-allocations", requireAuth, requireRole("WORKER"), requireVerifiedKyc, getMyAllocations);
router.put("/my-allocations", requireAuth, requireRole("WORKER"), requireVerifiedKyc, replaceMyAllocations);
router.get("/:fundId", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), getFund);
router.patch("/:fundId", requireAuth, requireRole("FUND_MANAGER"), updateFund);
router.get("/:fundId/allocations", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), getFundAllocations);

module.exports = router;
