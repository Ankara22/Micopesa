const express = require("express");
const cors = require("cors");
const pool = require("./db/database");
const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        message: "MicoPesa API is running"
    });
});

app.get("/api/health/db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW() AS current_time");
        res.json({
            status: "success",
            message: "PostgreSQL connection is working",
            time: result.rows[0].current_time
        });
    } catch (error) {
        console.error("Database connection failed:", error);
        res.status(500).json({
            status: "error",
            message: "Database connection failed"
        });
    }
});

app.listen(PORT, () => {
    console.log(`MicoPesa API running on http://localhost:${PORT}`);
});
