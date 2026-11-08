require("./config/loadEnvironment");
const { assertSafeAuthConfiguration } = require("./utils/authConfiguration");
assertSafeAuthConfiguration();

const express = require("express");
const cors = require("cors");
const pool = require("./db/database");
const { sendSms } = require("./services/smsService");
const { sendAdminEmail } = require("./services/adminEmailNotificationService");
const {
    createSmsDeliveryDispatcher,
    enabledChannels,
} = require("./services/smsDeliveryDispatcher");
const {
    createSmsNotificationRepository,
} = require("./services/smsNotificationRepository");
const { createNotificationRepository } = require("./services/notificationRepository");
const { createWebPushService } = require("./services/webPushService");
const { createGeneralJsonParser } = require("./middleware/mpesaCallbackIngress");
const mobileSasaDlrRoutes = require("./routes/mobileSasaDlrRoutes");
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
const fundManagerRoutes = require("./routes/fundManagerRoutes");
const regulatorRoutes = require("./routes/regulatorRoutes");
const mpesaRoutes = require("./routes/mpesaRoutes");
const profileRoutes = require("./routes/profileRoutes");
const reportRoutes = require("./routes/reportRoutes");
const regulatorFundAssignmentRoutes = require("./routes/regulatorFundAssignmentRoutes");
const adminOperationalSettingsRoutes = require("./routes/adminOperationalSettingsRoutes");
const staffOnboardingRoutes = require("./routes/staffOnboardingRoutes");
const app = express();
const PORT = process.env.PORT || 5000;


app.use(cors({
    exposedHeaders: [
        "X-Report-Truncated",
        "X-Report-Row-Count",
        "X-Report-Total-Count",
        "X-Report-Total-Count-Is-Lower-Bound",
        "X-Statement-Row-Count",
        "X-Statement-Total-Count",
        "X-Statement-Truncated",
    ],
}));
app.use(createGeneralJsonParser());

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
app.use("/api/v1/admin/settings", adminOperationalSettingsRoutes);
app.use("/api/v1/admin/staff", staffOnboardingRoutes);
app.use("/api/admin/notifications", notificationRoutes);
app.use("/api/integrations/mobilesasa", mobileSasaDlrRoutes);
app.use("/api/notifications", workerNotificationRoutes);
app.use("/api/admin/activity", activityRoutes);
app.use("/api/fund-manager", fundManagerRoutes);
app.use("/api/regulator", regulatorRoutes);
app.use("/api/mpesa", mpesaRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/admin/regulator-fund-assignments", regulatorFundAssignmentRoutes);

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

if (require.main === module) {
    const server = app.listen(PORT, () => {
        console.log(`MicoPesa API running on http://localhost:${PORT}`);
    });
    let smsDispatcher = null;
    const activeNotificationChannels = enabledChannels(process.env);
    if (activeNotificationChannels.length > 0) {
        const notificationRepository = createSmsNotificationRepository(pool);
        const webPushService = createWebPushService({
            repository: createNotificationRepository(pool),
        });
        smsDispatcher = createSmsDeliveryDispatcher({
            repository: notificationRepository,
            sendSms: (message) => sendSms(message, {
                provider: process.env.NOTIFICATION_SMS_PROVIDER?.trim().toUpperCase() || "AFRICAS_TALKING",
            }),
            sendEmail: sendAdminEmail,
            sendPush: (notification) => webPushService.sendToUser(notification),
        });
        smsDispatcher.start();
    } else if (
        process.env.SMS_DISPATCHER_ENABLED === "true" ||
        process.env.NOTIFICATION_DISPATCHER_ENABLED === "true" ||
        process.env.EMAIL_NOTIFICATIONS_ENABLED === "true"
    ) {
        console.error("Notification dispatcher was not started because production channel configuration is incomplete.");
    }

    let shuttingDown = false;
    async function shutdown() {
        if (shuttingDown) return;
        shuttingDown = true;
        const failures = [];
        try {
            await smsDispatcher?.stop();
        } catch (error) {
            failures.push(error);
        }
        try {
            await new Promise((resolve, reject) => {
                server.close((error) => error ? reject(error) : resolve());
            });
        } catch (error) {
            failures.push(error);
        }
        try {
            await pool.end();
        } catch (error) {
            failures.push(error);
        }
        if (failures.length) throw failures[0];
    }

    process.once("SIGINT", () => {
        shutdown().catch((error) => {
            console.error("API shutdown failed.", {
                code: typeof error?.code === "string" ? error.code : "SHUTDOWN_ERROR",
            });
            process.exitCode = 1;
        });
    });
    process.once("SIGTERM", () => {
        shutdown().catch((error) => {
            console.error("API shutdown failed.", {
                code: typeof error?.code === "string" ? error.code : "SHUTDOWN_ERROR",
            });
            process.exitCode = 1;
        });
    });
}

module.exports = app;
