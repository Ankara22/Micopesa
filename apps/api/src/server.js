const express = require("express");
const cors = require("cors");
const pool = require("./db/database");
const authRoutes = require("./routes/authRoutes");
const accountRoutes = require("./routes/accountRoutes");
const retirementRoutes = require("./routes/retirementRoutes");
const withdrawalRoutes = require("./routes/withdrawalRoutes");
const literacyRoutes = require("./routes/literacyRoutes");
const fundRoutes = require("./routes/fundRoutes");
const complianceReportRoutes = require("./routes/complianceReportRoutes");
const auditLogRoutes = require("./routes/auditLogRoutes");
const adminUserRoutes = require("./routes/adminUserRoutes");
const systemSettingsRoutes = require("./routes/systemSettingsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const workerNotificationRoutes = require("./routes/workerNotificationRoutes");
const activityRoutes = require("./routes/activityRoutes");
const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/accounts", accountRoutes);
app.use("/api/retirement", retirementRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/literacy", literacyRoutes);
app.use("/api/funds", fundRoutes);
app.use("/api/compliance-reports", complianceReportRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/admin/users", adminUserRoutes);
app.use("/api/admin/settings", systemSettingsRoutes);
app.use("/api/admin/notifications", notificationRoutes);
app.use("/api/notifications", workerNotificationRoutes);
app.use("/api/admin/activity", activityRoutes);

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
