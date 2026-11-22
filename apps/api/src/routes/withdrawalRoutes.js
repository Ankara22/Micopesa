const express = require("express");
const {
    checkEligibility,
    submitClaim,
    getMyClaims,
    getPendingClaims,
    approveClaim,
    rejectClaim,
    getPayoutAuthorizationQueue,
    createPayoutOtp,
    resendPayoutOtp,
    verifyPayoutOtp,
} = require("../controllers/withdrawalController");
const { requireAuth, requireRole, requireVerifiedKyc } = require("../middleware/authMiddleware");

const router = express.Router();

// WORKER
router.get("/eligibility", requireAuth, requireRole("WORKER"), requireVerifiedKyc, checkEligibility);
router.post("/", requireAuth, requireRole("WORKER"), requireVerifiedKyc, submitClaim);
router.get("/my-claims", requireAuth, requireRole("WORKER"), requireVerifiedKyc, getMyClaims);
router.post("/:claimId/payout-otp/verify", requireAuth, requireRole("WORKER"), requireVerifiedKyc, verifyPayoutOtp);

// FUND_MANAGER
router.get("/pending", requireAuth, requireRole("FUND_MANAGER"), getPendingClaims);
router.patch("/:claimId/approve", requireAuth, requireRole("FUND_MANAGER"), approveClaim);
router.patch("/:claimId/reject", requireAuth, requireRole("FUND_MANAGER"), rejectClaim);

// PAYOUT_OFFICER. These routes authorize payouts only; no payout executor exists.
router.get("/payout/authorizations", requireAuth, requireRole("PAYOUT_OFFICER"), getPayoutAuthorizationQueue);
router.post("/:claimId/payout-otp", requireAuth, requireRole("PAYOUT_OFFICER"), createPayoutOtp);
router.post("/:claimId/payout-otp/resend", requireAuth, requireRole("PAYOUT_OFFICER"), resendPayoutOtp);

module.exports = router;
