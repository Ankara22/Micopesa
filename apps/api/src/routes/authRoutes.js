const express = require("express");
const { register, login, logout, getMe } = require("../controllers/authController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, getMe);

// --- RBAC verification/test endpoints ---
// These do not touch the database; they exist purely to confirm that
// requireAuth / requireRole are wired correctly end-to-end.
router.get("/test", requireAuth, (req, res) => {
    return res.status(200).json({
        status: "success",
        message: "Token is valid and the request is authenticated",
        data: { userId: req.user.userId, role: req.user.role },
    });
});

router.get("/test/worker", requireAuth, requireRole("WORKER"), (req, res) => {
    return res.status(200).json({
        status: "success",
        message: "WORKER access confirmed",
        data: { userId: req.user.userId, role: req.user.role },
    });
});

router.get("/test/fund-manager", requireAuth, requireRole("FUND_MANAGER"), (req, res) => {
    return res.status(200).json({
        status: "success",
        message: "FUND_MANAGER access confirmed",
        data: { userId: req.user.userId, role: req.user.role },
    });
});

router.get("/test/regulator", requireAuth, requireRole("REGULATOR"), (req, res) => {
    return res.status(200).json({
        status: "success",
        message: "REGULATOR access confirmed",
        data: { userId: req.user.userId, role: req.user.role },
    });
});

router.get("/test/admin", requireAuth, requireRole("ADMIN"), (req, res) => {
    return res.status(200).json({
        status: "success",
        message: "ADMIN access confirmed",
        data: { userId: req.user.userId, role: req.user.role },
    });
});

// Example of the multi-role call style: FUND_MANAGER or REGULATOR only.
router.get("/test/fund-manager-or-regulator", requireAuth, requireRole("FUND_MANAGER", "REGULATOR"), (req, res) => {
    return res.status(200).json({
        status: "success",
        message: "FUND_MANAGER or REGULATOR access confirmed",
        data: { userId: req.user.userId, role: req.user.role },
    });
});

module.exports = router;