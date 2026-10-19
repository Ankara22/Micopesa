async function writeAuditLog(client, { userId, actionType, entityName, entityId }) {
    await client.query(
        `INSERT INTO audit_logs (user_id, action_type, entity_name, entity_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, actionType, entityName, entityId]
    );
}

module.exports = { writeAuditLog };
