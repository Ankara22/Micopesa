const express = require("express");
const {
    getOperationalSettings,
    updateOperationalSettings,
} = require("../controllers/adminOperationalSettingsController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", requireAuth, requireRole("ADMIN"), getOperationalSettings);
router.put("/", requireAuth, requireRole("ADMIN"), updateOperationalSettings);

module.exports = router;
