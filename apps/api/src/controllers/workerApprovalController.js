const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");
const { enqueueBusinessNotification } = require("../services/notificationEventService");

const VALID_DECISIONS = new Set(["APPROVED", "REJECTED"]);

async function listWorkerApplications(_req, res) {
    try {
        const result = await pool.query(
            `SELECT u.user_id, u.full_name, COALESCE(u.email, u.pending_email) AS email,
                    u.email_verified, u.phone, u.phone_verified_at,
                    u.account_status, u.approval_status, u.created_at,
                    k.kyc_status, k.national_id_last_four
             FROM users u
             LEFT JOIN kyc_records k ON k.user_id = u.user_id
             WHERE u.role = 'WORKER'
               AND u.approval_status IN ('PENDING', 'REJECTED')
             ORDER BY u.created_at ASC, u.user_id ASC`
        );
        return res.status(200).json({
            status: "success",
            data: result.rows.map(({ national_id_last_four: lastFour, ...application }) => ({
                ...application,
                masked_national_id: typeof lastFour === "string" && /^\d{4}$/.test(lastFour.trim())
                    ? `****${lastFour.trim()}`
                    : null,
            })),
        });
    } catch (error) {
        console.error("Failed to load worker applications.", {
            code: typeof error?.code === "string" ? error.code : "WORKER_APPROVAL_LIST_FAILED",
        });
        return res.status(500).json({
            status: "error",
            message: "Unable to load worker applications right now.",
        });
    }
}

async function decideWorkerApplication(req, res) {
    const workerUserId = req.params.userId;
    const decision = req.body?.decision;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (typeof workerUserId !== "string" ||
        !/^[A-F0-9]{25}$/.test(workerUserId) ||
        !VALID_DECISIONS.has(decision) ||
        reason.length < 10 ||
        reason.length > 500) {
        return res.status(400).json({
            status: "error",
            message: "Provide a valid worker, decision, and a reason of 10 to 500 characters.",
        });
    }

    let client;
    let transactionStarted = false;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        transactionStarted = true;
        const result = await client.query(
            `SELECT user_id, role, account_status, approval_status
             FROM users WHERE user_id = $1 FOR UPDATE`,
            [workerUserId]
        );
        const worker = result.rows[0];
        if (!worker || worker.role !== "WORKER") {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(404).json({
                status: "error",
                message: "Worker application not found.",
            });
        }
        if (!["PENDING", "REJECTED"].includes(worker.approval_status)) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                code: "WORKER_APPLICATION_ALREADY_APPROVED",
                message: "This worker application is not awaiting an approval decision.",
            });
        }
        const updated = await client.query(
            `UPDATE users
             SET approval_status = $1,
                 auth_version = auth_version + 1,
                 updated_at = now()
             WHERE user_id = $2 AND role = 'WORKER'
               AND approval_status = $3
             RETURNING user_id, approval_status`,
            [decision, workerUserId, worker.approval_status]
        );
        if (!updated.rows[0]) {
            await client.query("ROLLBACK");
            transactionStarted = false;
            return res.status(409).json({
                status: "error",
                code: "WORKER_APPLICATION_CHANGED",
                message: "The worker application changed. Refresh and try again.",
            });
        }
        const review = await client.query(
            `INSERT INTO worker_approval_reviews (
                worker_user_id, reviewed_by_user_id, previous_status, decision, reason
             ) VALUES ($1, $2, $3, $4, $5)
             RETURNING review_id`,
            [workerUserId, req.user.userId, worker.approval_status, decision, reason]
        );
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: decision === "APPROVED" ? "APPROVE" : "REJECT",
            entityName: "WORKER_APPROVAL",
            entityId: workerUserId,
            details: {
                previous_status: worker.approval_status,
                decision,
                reason,
            },
        });
        await client.query("COMMIT");
        transactionStarted = false;
        void enqueueBusinessNotification({
            userId: workerUserId,
            eventType: decision === "APPROVED" ? "WORKER_APPROVED" : "WORKER_REJECTED",
            referenceId: String(review.rows[0].review_id),
        });
        return res.status(200).json({
            status: "success",
            data: { user_id: workerUserId, approval_status: decision },
        });
    } catch (error) {
        if (client && transactionStarted) await client.query("ROLLBACK").catch(() => {});
        console.error("Worker approval decision failed.", {
            code: typeof error?.code === "string" ? error.code : "WORKER_APPROVAL_DECISION_FAILED",
        });
        return res.status(500).json({
            status: "error",
            message: "Unable to save the worker approval decision.",
        });
    } finally {
        client?.release();
    }
}

async function listWorkerApprovalHistory(req, res) {
    const workerUserId = req.params.userId;
    if (typeof workerUserId !== "string" || !/^[A-F0-9]{25}$/.test(workerUserId)) {
        return res.status(400).json({ status: "error", message: "A valid user ID is required." });
    }
    try {
        const result = await pool.query(
            `SELECT r.review_id, r.previous_status, r.decision, r.reason, r.created_at,
                    r.reviewed_by_user_id,
                    COALESCE(actor.full_name, 'Deleted administrator') AS reviewed_by_name
             FROM worker_approval_reviews r
             LEFT JOIN users actor ON actor.user_id = r.reviewed_by_user_id
             WHERE r.worker_user_id = $1
             ORDER BY r.created_at DESC, r.review_id DESC`,
            [workerUserId]
        );
        return res.status(200).json({ status: "success", data: result.rows });
    } catch (error) {
        console.error("Failed to load worker approval history.", {
            code: typeof error?.code === "string" ? error.code : "WORKER_APPROVAL_HISTORY_FAILED",
        });
        return res.status(500).json({
            status: "error",
            message: "Unable to load approval history right now.",
        });
    }
}

module.exports = {
    decideWorkerApplication,
    listWorkerApplications,
    listWorkerApprovalHistory,
};
