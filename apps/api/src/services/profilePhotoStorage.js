const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const sharp = require("sharp");

const MAX_PROFILE_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PROFILE_PHOTO_DIMENSION = 4096;
const MAX_PROFILE_PHOTO_PIXELS = 16_000_000;
const PHOTO_TYPES = {
    "image/jpeg": { extension: "jpg", format: "jpeg", signature: isJpeg },
    "image/png": { extension: "png", format: "png", signature: isPng },
    "image/webp": { extension: "webp", format: "webp", signature: isWebp },
};

function isJpeg(buffer) {
    return buffer.length >= 4 &&
        buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
        buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
}

function isPng(buffer) {
    return buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

function isWebp(buffer) {
    return buffer.length >= 12 &&
        buffer.toString("ascii", 0, 4) === "RIFF" &&
        buffer.toString("ascii", 8, 12) === "WEBP";
}

function detectImageType(buffer) {
    if (!Buffer.isBuffer(buffer)) return null;
    return Object.entries(PHOTO_TYPES).find(([, type]) => type.signature(buffer))?.[0] || null;
}

function hasCompleteImageContainer(buffer, contentType) {
    if (contentType === "image/jpeg") return isJpeg(buffer);
    if (contentType === "image/webp") {
        return isWebp(buffer) && buffer.readUInt32LE(4) + 8 === buffer.length;
    }
    if (contentType !== "image/png" || !isPng(buffer)) return false;

    let offset = 8;
    while (offset + 12 <= buffer.length) {
        const chunkLength = buffer.readUInt32BE(offset);
        const chunkEnd = offset + chunkLength + 12;
        if (chunkEnd > buffer.length) return false;
        const chunkType = buffer.toString("ascii", offset + 4, offset + 8);
        if (chunkType === "IEND") {
            return chunkLength === 0 && chunkEnd === buffer.length;
        }
        offset = chunkEnd;
    }
    return false;
}

function getStorageDirectory() {
    if (process.env.NODE_ENV === "production" && !process.env.PROFILE_PHOTO_STORAGE_DIR) {
        const error = new Error("Persistent profile-photo storage is not configured");
        error.code = "PROFILE_PHOTO_STORAGE_UNCONFIGURED";
        throw error;
    }
    return path.resolve(
        process.env.PROFILE_PHOTO_STORAGE_DIR ||
        path.join(__dirname, "..", "..", "storage", "profile-photos")
    );
}

function isSafePhotoReference(reference) {
    return typeof reference === "string" &&
        /^[a-f0-9]{32}\.(jpg|png|webp)$/.test(reference);
}

async function validateImageContent(buffer, contentType) {
    const type = PHOTO_TYPES[contentType];
    const detectedType = detectImageType(buffer);
    if (!type || detectedType !== contentType || !hasCompleteImageContainer(buffer, contentType)) {
        const error = new Error("Upload a valid JPEG, PNG, or WebP image");
        error.status = 415;
        throw error;
    }

    const options = {
        failOn: "warning",
        limitInputPixels: MAX_PROFILE_PHOTO_PIXELS,
        limitInputChannels: 4,
    };
    try {
        const metadata = await sharp(buffer, options).metadata();
        if (
            metadata.format !== type.format ||
            !Number.isInteger(metadata.width) ||
            !Number.isInteger(metadata.height) ||
            metadata.width < 1 ||
            metadata.height < 1 ||
            metadata.width > MAX_PROFILE_PHOTO_DIMENSION ||
            metadata.height > MAX_PROFILE_PHOTO_DIMENSION ||
            metadata.width * metadata.height > MAX_PROFILE_PHOTO_PIXELS
        ) {
            throw new Error("Unsupported image structure or dimensions");
        }

        const { info } = await sharp(buffer, options).toBuffer({ resolveWithObject: true });
        if (
            info.format !== type.format ||
            info.width < 1 ||
            info.height < 1 ||
            info.width > MAX_PROFILE_PHOTO_DIMENSION ||
            info.height > MAX_PROFILE_PHOTO_DIMENSION ||
            info.width * info.height > MAX_PROFILE_PHOTO_PIXELS
        ) {
            throw new Error("Decoded image content does not match its declared format");
        }
    } catch {
        const error = new Error("Upload a complete, valid JPEG, PNG, or WebP image within the allowed dimensions");
        error.status = 415;
        throw error;
    }
}

async function saveProfilePhoto(buffer, contentType) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        const error = new Error("A profile photo is required");
        error.status = 400;
        throw error;
    }
    if (buffer.length > MAX_PROFILE_PHOTO_BYTES) {
        const error = new Error("Profile photos must be 5 MB or smaller");
        error.status = 413;
        throw error;
    }
    await validateImageContent(buffer, contentType);

    const directory = getStorageDirectory();
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const reference = `${randomUUID().replace(/-/g, "")}.${PHOTO_TYPES[contentType].extension}`;
    await fs.writeFile(path.join(directory, reference), buffer, { flag: "wx", mode: 0o600 });
    return { reference, contentType };
}

async function readProfilePhoto(reference) {
    if (!isSafePhotoReference(reference)) return null;
    const contentType = Object.entries(PHOTO_TYPES)
        .find(([, type]) => reference.endsWith(`.${type.extension}`))?.[0];
    if (!contentType) return null;
    const buffer = await fs.readFile(path.join(getStorageDirectory(), reference));
    if (detectImageType(buffer) !== contentType) {
        throw new Error("Stored profile photo failed content validation");
    }
    return { buffer, contentType };
}

async function removeProfilePhoto(reference) {
    if (!isSafePhotoReference(reference)) return;
    await fs.rm(path.join(getStorageDirectory(), reference), { force: true });
}

module.exports = {
    MAX_PROFILE_PHOTO_BYTES,
    MAX_PROFILE_PHOTO_DIMENSION,
    MAX_PROFILE_PHOTO_PIXELS,
    detectImageType,
    getStorageDirectory,
    hasCompleteImageContainer,
    isSafePhotoReference,
    readProfilePhoto,
    removeProfilePhoto,
    saveProfilePhoto,
    validateImageContent,
};
