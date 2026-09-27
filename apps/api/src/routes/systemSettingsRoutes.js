const express = require("express");
const {
    listSettings,
    getSetting,
    createSetting,
    updateSetting,
    deleteSetting,
} = require("../controllers/systemSettingsController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", requireAuth, requireRole("ADMIN"), listSettings);
router.get("/:key", requireAuth, requireRole("ADMIN"), getSetting);
router.post("/", requireAuth, requireRole("ADMIN"), createSetting);
router.put("/:key", requireAuth, requireRole("ADMIN"), updateSetting);
router.delete("/:key", requireAuth, requireRole("ADMIN"), deleteSetting);

module.exports = router;
