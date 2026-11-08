const express = require("express");
const { getMyBalance, getMyContributions, initiateMyContribution } = require("../controllers/accountController");
const { download: downloadMyStatement } = require("../controllers/workerStatementController");
const { verifyToken, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my-balance", verifyToken, requireRole(["WORKER"]), getMyBalance);
router.get("/my-contributions", verifyToken, requireRole(["WORKER"]), getMyContributions);
router.post("/my-contributions", verifyToken, requireRole("WORKER"), initiateMyContribution);
router.get("/my-statement", verifyToken, requireRole("WORKER"), downloadMyStatement);

module.exports = router;
