const express = require("express");
const { listUsers, getUser, updateUserRole, updateUserStatus } = require("../controllers/adminUserController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", requireAuth, requireRole("ADMIN"), listUsers);
router.get("/:userId", requireAuth, requireRole("ADMIN"), getUser);
router.patch("/:userId/role", requireAuth, requireRole("ADMIN"), updateUserRole);
router.patch("/:userId/status", requireAuth, requireRole("ADMIN"), updateUserStatus);

module.exports = router;
