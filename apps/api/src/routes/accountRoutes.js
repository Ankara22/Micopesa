const express = require("express");
const { getMyBalance, getMyContributions, initiateMyContribution } = require("../controllers/accountController");
const { download: downloadMyStatement } = require("../controllers/workerStatementController");
const { verifyToken, requireRole, requireVerifiedKyc } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/my-balance", verifyToken, requireRole(["WORKER"]), requireVerifiedKyc, getMyBalance);
router.get("/my-contributions", verifyToken, requireRole(["WORKER"]), requireVerifiedKyc, getMyContributions);
router.post("/my-contributions", verifyToken, requireRole("WORKER"), requireVerifiedKyc, initiateMyContribution);
router.get("/my-statement", verifyToken, requireRole("WORKER"), requireVerifiedKyc, downloadMyStatement);

module.exports = router;
