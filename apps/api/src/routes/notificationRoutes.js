const express = require("express");
const {
    createNotification,
    getExternalSmsAvailability,
    sendExternalRecipientSms,
    sendAdminTestSms,
    listNotifications,
    listRecipients,
} = require("../controllers/notificationController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", requireAuth, requireRole("ADMIN"), createNotification);
router.get("/external-sms/availability", requireAuth, requireRole("ADMIN"), getExternalSmsAvailability);
router.post("/external-sms", requireAuth, requireRole("ADMIN"), sendExternalRecipientSms);
router.post("/test-sms", requireAuth, requireRole("ADMIN"), sendAdminTestSms);
router.get("/recipients", requireAuth, requireRole("ADMIN"), listRecipients);
router.get("/", requireAuth, requireRole("ADMIN"), listNotifications);

module.exports = router;
