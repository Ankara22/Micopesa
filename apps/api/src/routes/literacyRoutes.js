const express = require("express");
const { listArticles } = require("../controllers/literacyController");
const { requireAuth, requireRole } = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/", requireAuth, requireRole("WORKER"), listArticles);

module.exports = router;
