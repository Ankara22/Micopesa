const express = require("express");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");
const {
    assign,
    list,
    listCandidates,
    revoke,
} = require("../controllers/regulatorFundAssignmentController");

const router = express.Router();

router.use(requireAuth, requireRole("ADMIN"));
router.get("/", list);
router.get("/candidates", listCandidates);
router.post("/", assign);
router.delete("/:regulatorId/:fundId", revoke);

module.exports = router;
