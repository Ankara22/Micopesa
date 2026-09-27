const express = require("express");
const { getPlan, upsertPlan } = require("../controllers/retirementController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my-plan", requireAuth, requireRole("WORKER"), getPlan);
router.post("/my-plan", requireAuth, requireRole("WORKER"), upsertPlan);

module.exports = router;
