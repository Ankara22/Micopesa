require("dotenv").config();
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const http = require("http");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function request({ method, path, token, body }) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                hostname: "127.0.0.1",
                port: process.env.PORT || 5000,
                path,
                method,
                headers: {
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (c) => (data += c));
                res.on("end", () => {
                    let parsed = data;
                    try {
                        parsed = JSON.parse(data);
                    } catch {
                        /* keep raw */
                    }
                    resolve({ status: res.statusCode, body: parsed });
                });
            }
        );
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

(async () => {
    const admin = await pool.query(
        "SELECT user_id, role FROM users WHERE role = 'ADMIN' LIMIT 1"
    );
    const worker = await pool.query(
        "SELECT user_id, role, account_status FROM users WHERE role = 'WORKER' ORDER BY created_at LIMIT 1"
    );
    if (!admin.rows[0] || !worker.rows[0]) {
        throw new Error("Need an ADMIN and a WORKER in the database");
    }
    const token = jwt.sign(
        { userId: admin.rows[0].user_id, role: admin.rows[0].role },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
    );
    const userId = worker.rows[0].user_id;
    const original = { role: worker.rows[0].role, account_status: worker.rows[0].account_status };

    console.log("TARGET", { userId, original });

    const statusRes = await request({
        method: "PATCH",
        path: `/api/admin/users/${userId}/status`,
        token,
        body: { account_status: "SUSPENDED" },
    });
    console.log("STATUS_PATCH", JSON.stringify(statusRes));

    const afterStatus = await pool.query(
        "SELECT role, account_status FROM users WHERE user_id = $1",
        [userId]
    );
    console.log("AFTER_STATUS_DB", afterStatus.rows[0]);

    const roleRes = await request({
        method: "PATCH",
        path: `/api/admin/users/${userId}/role`,
        token,
        body: { role: "REGULATOR" },
    });
    console.log("ROLE_PATCH", JSON.stringify(roleRes));

    const afterRole = await pool.query(
        "SELECT role, account_status FROM users WHERE user_id = $1",
        [userId]
    );
    console.log("AFTER_ROLE_DB", afterRole.rows[0]);

    await pool.query(
        "UPDATE users SET role = $1, account_status = $2, updated_at = now() WHERE user_id = $3",
        [original.role, original.account_status, userId]
    );
    const restored = await pool.query(
        "SELECT role, account_status FROM users WHERE user_id = $1",
        [userId]
    );
    console.log("RESTORED", restored.rows[0]);

    const unauth = await request({
        method: "PATCH",
        path: `/api/admin/users/${userId}/status`,
        body: { account_status: "INACTIVE" },
    });
    console.log("UNAUTH", unauth.status, unauth.body && unauth.body.message);

    const workerToken = jwt.sign(
        { userId: userId, role: "WORKER" },
        process.env.JWT_SECRET,
        { expiresIn: "10m" }
    );
    const forbidden = await request({
        method: "PATCH",
        path: `/api/admin/users/${userId}/status`,
        token: workerToken,
        body: { account_status: "INACTIVE" },
    });
    console.log("FORBIDDEN", forbidden.status, forbidden.body && forbidden.body.message);

    const invalid = await request({
        method: "PATCH",
        path: `/api/admin/users/${userId}/status`,
        token,
        body: { account_status: "CLOSED" },
    });
    console.log("INVALID_STATUS", invalid.status, invalid.body && invalid.body.message);

    await pool.end();
})().catch((e) => {
    console.error("ERR", e.code || "", e.message);
    process.exit(1);
});
