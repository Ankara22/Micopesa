const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const {
    listDuplicateSubmissions,
    listPendingSubmissions,
    revealNationalId,
    reviewSubmission,
} = require("../controllers/kycReviewController");

const router = express.Router();

router.use(requireAuth, requireRole("ADMIN"));
router.get("/pending", listPendingSubmissions);
router.get("/duplicate-submissions", listDuplicateSubmissions);
router.post("/:kycId/national-id/reveal", revealNationalId);
router.patch("/:kycId/review", reviewSubmission);

module.exports = router;
