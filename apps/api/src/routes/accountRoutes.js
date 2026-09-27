const express = require("express");
const { getMyBalance, getMyContributions } = require("../controllers/accountController");
const { verifyToken, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my-balance", verifyToken, requireRole(["WORKER"]), getMyBalance);
router.get("/my-contributions", verifyToken, requireRole(["WORKER"]), getMyContributions);

module.exports = router;
