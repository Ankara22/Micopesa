const express = require("express");
const {
    checkEligibility,
    submitClaim,
    getMyClaims,
    getPendingClaims,
    approveClaim,
    rejectClaim,
} = require("../controllers/withdrawalController");
const { requireAuth, requireRole, requireVerifiedKyc } = require("../middleware/authMiddleware");

const router = express.Router();

// WORKER
router.get("/eligibility", requireAuth, requireRole("WORKER"), requireVerifiedKyc, checkEligibility);
router.post("/", requireAuth, requireRole("WORKER"), requireVerifiedKyc, submitClaim);
router.get("/my-claims", requireAuth, requireRole("WORKER"), requireVerifiedKyc, getMyClaims);

// FUND_MANAGER
router.get("/pending", requireAuth, requireRole("FUND_MANAGER"), getPendingClaims);
router.patch("/:claimId/approve", requireAuth, requireRole("FUND_MANAGER"), approveClaim);
router.patch("/:claimId/reject", requireAuth, requireRole("FUND_MANAGER"), rejectClaim);

module.exports = router;
