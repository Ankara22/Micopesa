const express = require("express");
const { requireAuth } = require("../middleware/authMiddleware");
const {
    getMyProfile,
    getMyProfilePhoto,
    updateMyProfile,
    uploadMyProfilePhoto,
} = require("../controllers/profileController");

const router = express.Router();
const parsePhotoBody = express.raw({
    type: ["image/jpeg", "image/png", "image/webp"],
    limit: "5mb",
});

router.get("/me", requireAuth, getMyProfile);
router.patch("/me", requireAuth, updateMyProfile);
router.get("/me/photo", requireAuth, getMyProfilePhoto);
router.put("/me/photo", requireAuth, parsePhotoBody, uploadMyProfilePhoto);

router.use((error, req, res, next) => {
    if (error.type === "entity.too.large") {
        return res.status(413).json({ status: "error", message: "Profile photos must be 5 MB or smaller" });
    }
    if (error.type === "encoding.unsupported" || error.type === "entity.parse.failed") {
        return res.status(400).json({ status: "error", message: "Invalid photo request body" });
    }
    return next(error);
});

module.exports = router;
