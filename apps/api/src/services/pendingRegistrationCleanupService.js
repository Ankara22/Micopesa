const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

async function deleteExpiredPendingRegistrations(pool) {
    return pool.query("DELETE FROM pending_registrations WHERE expires_at <= now()");
}

function startPendingRegistrationCleanup(pool) {
    let running = false;
    const cleanup = async () => {
        if (running) return;
        running = true;
        try {
            await deleteExpiredPendingRegistrations(pool);
        } catch (error) {
            console.error("Pending registration cleanup failed.", {
                code: error.code,
                message: error.message,
                detail: error.detail,
                hint: error.hint,
                position: error.position,
            });
        } finally {
            running = false;
        }
    };
    const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
    timer.unref();
    return () => clearInterval(timer);
}

module.exports = {
    deleteExpiredPendingRegistrations,
    startPendingRegistrationCleanup,
};
