const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const {
    listDuplicateSubmissions,
    listPendingSubmissions,
    reviewSubmission,
} = require("../controllers/kycReviewController");

const router = express.Router();

router.use(requireAuth, requireRole("ADMIN"));
router.get("/pending", listPendingSubmissions);
router.get("/duplicate-submissions", listDuplicateSubmissions);
router.patch("/:kycId/review", reviewSubmission);

module.exports = router;
