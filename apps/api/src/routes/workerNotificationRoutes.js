const express = require("express");
const {
    createNotification,
    getMyNotifications,
    getPushPublicKey,
    listNotificationAudit,
    listRoleRecipients,
    registerPushSubscription,
    removePushSubscription,
} = require("../controllers/notificationController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my", requireAuth, requireRole("WORKER", "FUND_MANAGER", "REGULATOR"), getMyNotifications);
router.post("/compose", requireAuth, requireRole("ADMIN", "FUND_MANAGER", "REGULATOR"), createNotification);
router.get("/recipients", requireAuth, requireRole("ADMIN", "FUND_MANAGER", "REGULATOR"), listRoleRecipients);
router.get("/audit", requireAuth, requireRole("ADMIN", "FUND_MANAGER", "REGULATOR"), listNotificationAudit);
router.get("/push/public-key", requireAuth, getPushPublicKey);
router.post("/push/subscriptions", requireAuth, registerPushSubscription);
router.delete("/push/subscriptions/:subscriptionId", requireAuth, removePushSubscription);

module.exports = router;