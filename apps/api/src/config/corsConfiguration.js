const DEVELOPMENT_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
];

function getAllowedCorsOrigins(environment = process.env) {
    const configured = environment.CORS_ALLOWED_ORIGINS;
    if (configured === undefined) {
        if (environment.NODE_ENV === "production") {
            const error = new Error("CORS_ALLOWED_ORIGINS must be configured in production.");
            error.code = "CORS_ORIGINS_CONFIGURATION_MISSING";
            throw error;
        }
        return [...DEVELOPMENT_ORIGINS];
    }
    if (typeof configured !== "string" || !configured.trim()) {
        const error = new Error("CORS_ALLOWED_ORIGINS must contain at least one origin.");
        error.code = "CORS_ORIGINS_CONFIGURATION_INVALID";
        throw error;
    }

    const origins = configured.split(",").map((origin) => origin.trim());
    if (origins.some((origin) => !origin)) {
        const error = new Error("CORS_ALLOWED_ORIGINS contains an empty origin.");
        error.code = "CORS_ORIGINS_CONFIGURATION_INVALID";
        throw error;
    }

    return [...new Set(origins.map((origin) => {
        let parsed;
        try {
            parsed = new URL(origin);
        } catch {
            parsed = null;
        }
        if (
            !parsed ||
            !["http:", "https:"].includes(parsed.protocol) ||
            parsed.origin !== origin ||
            parsed.username ||
            parsed.password ||
            (environment.NODE_ENV === "production" && parsed.protocol !== "https:")
        ) {
            const error = new Error("CORS_ALLOWED_ORIGINS must contain valid trusted origins.");
            error.code = "CORS_ORIGINS_CONFIGURATION_INVALID";
            throw error;
        }
        return parsed.origin;
    }))];
}

function createCorsOptions(environment = process.env) {
    const allowedOrigins = new Set(getAllowedCorsOrigins(environment));
    return {
        origin(origin, callback) {
            callback(null, !origin || allowedOrigins.has(origin));
        },
    };
}

module.exports = {
    createCorsOptions,
    getAllowedCorsOrigins,
};
