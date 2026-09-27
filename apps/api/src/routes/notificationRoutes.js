const express = require("express");
const { createNotification, listNotifications } = require("../controllers/notificationController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", requireAuth, requireRole("ADMIN"), createNotification);
router.get("/", requireAuth, requireRole("ADMIN"), listNotifications);

module.exports = router;
