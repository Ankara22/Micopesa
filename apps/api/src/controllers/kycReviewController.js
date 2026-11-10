const pool = require("../db/database");
const { writeAuditLog } = require("../utils/auditLog");

async function listPendingSubmissions(_req, res) {
    try {
        const result = await pool.query(
            `SELECT k.kyc_id, k.user_id, u.full_name, u.email, u.phone,
                    k.date_of_birth,
                    right(k.national_id, 4) AS national_id_last_four,
                    k.kyc_status, k.duplicate_submission, k.created_at
             FROM kyc_records k
             JOIN users u ON u.user_id = k.user_id
             WHERE k.kyc_status = 'PENDING'
             ORDER BY k.created_at ASC, k.kyc_id ASC`
        );
        return res.status(200).json({
            status: "success",
            data: result.rows.map(({ national_id_last_four: lastFour, ...submission }) => ({
                ...submission,
                masked_national_id: typeof lastFour === "string" && /^\d{4}$/.test(lastFour)
                    ? `****${lastFour}`
                    : null,
            })),
        });
    } catch (error) {
        console.error("Failed to load pending KYC submissions:", error.code || "KYC_REVIEW_READ_FAILED");
        return res.status(500).json({ status: "error", message: "Unable to load KYC review items." });
    }
}

async function listDuplicateSubmissions(_req, res) {
    try {
        const result = await pool.query(
            `SELECT k.kyc_id, k.user_id, u.full_name, u.email, k.date_of_birth,
                    right(k.national_id, 4) AS national_id_last_four,
                    k.kyc_status, k.created_at
             FROM kyc_records k
             JOIN users u ON u.user_id = k.user_id
             WHERE k.duplicate_submission IS TRUE
               AND k.kyc_status = 'PENDING'
             ORDER BY k.created_at ASC, k.kyc_id ASC`
        );
        return res.status(200).json({
            status: "success",
            data: result.rows.map(({ national_id_last_four: lastFour, ...submission }) => ({
                ...submission,
                masked_national_id: typeof lastFour === "string" && /^\d{4}$/.test(lastFour)
                    ? `****${lastFour}`
                    : null,
            })),
        });
    } catch (error) {
        console.error("Failed to load duplicate KYC submissions:", error.code || "KYC_REVIEW_READ_FAILED");
        return res.status(500).json({ status: "error", message: "Unable to load KYC review items." });
    }
}

async function reviewSubmission(req, res) {
    const status = req.body?.status;
    if (!["VERIFIED", "REJECTED"].includes(status)) {
        return res.status(400).json({
            status: "error",
            message: "status must be VERIFIED or REJECTED",
        });
    }

    let client;
    try {
        client = await pool.connect();
        await client.query("BEGIN");
        const current = await client.query(
            "SELECT kyc_id, kyc_status FROM kyc_records WHERE kyc_id = $1 FOR UPDATE",
            [req.params.kycId]
        );
        if (!current.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(404).json({ status: "error", message: "KYC record not found." });
        }
        if (current.rows[0].kyc_status !== "PENDING") {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                code: "KYC_SUBMISSION_ALREADY_REVIEWED",
                message: "Only pending KYC submissions can be reviewed.",
            });
        }

        const updated = await client.query(
            `UPDATE kyc_records
             SET kyc_status = $1::varchar,
                 verified_at = CASE WHEN $1::varchar = 'VERIFIED' THEN now() ELSE NULL END
             WHERE kyc_id = $2 AND kyc_status = 'PENDING'
             RETURNING kyc_id, user_id, kyc_status, verified_at`,
            [status, req.params.kycId]
        );
        if (!updated.rows[0]) {
            await client.query("ROLLBACK");
            return res.status(409).json({
                status: "error",
                code: "KYC_SUBMISSION_ALREADY_REVIEWED",
                message: "Only pending KYC submissions can be reviewed.",
            });
        }
        await writeAuditLog(client, {
            userId: req.user.userId,
            actionType: status === "VERIFIED" ? "APPROVE" : "REJECT",
            entityName: "KYC_RECORD",
            entityId: req.params.kycId,
            details: { status },
        });
        await client.query("COMMIT");
        return res.status(200).json({ status: "success", data: { submission: updated.rows[0] } });
    } catch (error) {
        if (client) await client.query("ROLLBACK").catch(() => {});
        if (error.code === "23505" && error.constraint === "uq_kyc_records_verified_national_id") {
            return res.status(409).json({
                status: "error",
                code: "KYC_NATIONAL_ID_ALREADY_VERIFIED",
                message: "This submission cannot be approved because its National ID is already verified.",
            });
        }
        console.error("KYC review failed:", error.code || "KYC_REVIEW_FAILED");
        return res.status(500).json({ status: "error", message: "Unable to update this KYC submission." });
    } finally {
        client?.release();
    }
}

module.exports = { listDuplicateSubmissions, listPendingSubmissions, reviewSubmission };
