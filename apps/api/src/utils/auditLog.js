async function writeAuditLog(client, { userId, actionType, entityName, entityId, details = null }) {
    try {
        await client.query(
            `INSERT INTO audit_logs (user_id, action_type, entity_name, entity_id, details)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [userId, actionType, entityName, entityId, details === null ? null : JSON.stringify(details)]
        );
    } catch (error) {
        console.error("Audit log insert failed:", {
            actionType,
            entityName,
            code: typeof error?.code === "string" ? error.code : "AUDIT_LOG_INSERT_FAILED",
        });
        throw error;
    }
}

module.exports = { writeAuditLog };
