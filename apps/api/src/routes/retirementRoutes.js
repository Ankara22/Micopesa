const express = require("express");
const { getPlan, upsertPlan } = require("../controllers/retirementController");
const { requireAuth, requireRole, requireVerifiedKyc } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my-plan", requireAuth, requireRole("WORKER"), requireVerifiedKyc, getPlan);
router.post("/my-plan", requireAuth, requireRole("WORKER"), requireVerifiedKyc, upsertPlan);

module.exports = router;
