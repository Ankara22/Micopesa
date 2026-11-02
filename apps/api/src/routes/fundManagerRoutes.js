const express = require("express");
const {
    getPerformance,
    listWithdrawals,
    reviewWithdrawal,
} = require("../controllers/fundManagerController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.use(requireAuth, requireRole("FUND_MANAGER"));
router.get("/performance", getPerformance);
router.get("/withdrawals", listWithdrawals);
router.patch("/withdrawals/:id/review", reviewWithdrawal);

module.exports = router;
