const express = require("express");
const { createStaff, resendStaffOnboarding } = require("../controllers/staffOnboardingController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", requireAuth, requireRole("ADMIN"), createStaff);
router.post("/:userId/resend", requireAuth, requireRole("ADMIN"), resendStaffOnboarding);

module.exports = router;
