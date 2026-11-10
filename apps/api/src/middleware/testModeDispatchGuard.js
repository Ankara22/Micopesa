function testModeDispatchGuard(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        return next();
    }

    return res.status(503).json({
        status: "error",
        message: "External dispatch is disabled in test mode.",
    });
}

module.exports = { testModeDispatchGuard };
