require("dotenv").config();
const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
    const cols = await pool.query(`
        SELECT column_name, data_type, character_maximum_length, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'users'
        ORDER BY ordinal_position`);
    const cons = await pool.query(`
        SELECT con.conname, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE rel.relname = 'users'`);
    const trig = await pool.query(`
        SELECT tgname, pg_get_triggerdef(t.oid) AS def
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'users' AND NOT t.tgisinternal`);
    const users = await pool.query(
        "SELECT user_id, full_name, role, account_status FROM users ORDER BY created_at"
    );
    console.log("COLUMNS", JSON.stringify(cols.rows, null, 2));
    console.log("CONSTRAINTS", JSON.stringify(cons.rows, null, 2));
    console.log("TRIGGERS", JSON.stringify(trig.rows, null, 2));
    console.log("USERS", JSON.stringify(users.rows, null, 2));
    await pool.end();
})().catch((e) => {
    console.error("ERR", e.code, e.message);
    process.exit(1);
});
