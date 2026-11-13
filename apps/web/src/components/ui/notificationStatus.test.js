import { describe, expect, it } from "vitest";
import { getCombinedNotificationStatus } from "./notificationStatus";

describe("getCombinedNotificationStatus", () => {
    it("reports all accepted channels as sent and fully confirmed channels as delivered", () => {
        expect(getCombinedNotificationStatus([
            { delivery_status: "PROVIDER_ACCEPTED" },
            { delivery_status: "SENT" },
        ])).toBe("PROVIDER_ACCEPTED");
        expect(getCombinedNotificationStatus([
            { delivery_status: "DELIVERED" },
            { delivery_status: "DELIVERED" },
        ])).toBe("DELIVERED");
    });

    it("reports accepted and failed channels as partially sent", () => {
        expect(getCombinedNotificationStatus([
            { delivery_status: "PROVIDER_ACCEPTED" },
            { delivery_status: "FAILED" },
        ])).toBe("PARTIALLY_SENT");
    });

    it("does not turn accepted and pending channels into unknown", () => {
        expect(getCombinedNotificationStatus([
            { delivery_status: "PROVIDER_ACCEPTED" },
            { delivery_status: "PENDING" },
        ])).toBe("PARTIALLY_SENT");
    });

    it("preserves processing and ambiguous states when no channel is accepted", () => {
        expect(getCombinedNotificationStatus([
            { delivery_status: "PENDING" },
            { delivery_status: "PROCESSING" },
        ])).toBe("PROCESSING");
        expect(getCombinedNotificationStatus([
            { delivery_status: "UNKNOWN" },
            { delivery_status: "UNKNOWN" },
        ])).toBe("UNKNOWN");
    });
});
