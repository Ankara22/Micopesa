import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import PushSubscriptionControl from "./PushSubscriptionControl";

const mocks = vi.hoisted(() => ({
    getPushPublicKey: vi.fn(),
    registerPushSubscription: vi.fn(),
    removePushSubscription: vi.fn(),
    useAuth: vi.fn(),
}));

vi.mock("../../services/notificationService", () => ({
    getPushPublicKey: mocks.getPushPublicKey,
    registerPushSubscription: mocks.registerPushSubscription,
    removePushSubscription: mocks.removePushSubscription,
}));
vi.mock("../../context/AuthContext", () => ({ useAuth: mocks.useAuth }));

describe("PushSubscriptionControl", () => {
    let registration;
    let subscription;

    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mocks.useAuth.mockReturnValue({ user: { user_id: "worker-1" } });
        mocks.getPushPublicKey.mockResolvedValue("AQIDBAUGBwgJCgsMDQ4PEA");
        mocks.registerPushSubscription.mockResolvedValue("sub-1");
        mocks.removePushSubscription.mockResolvedValue({});
        subscription = {
            toJSON: () => ({ endpoint: "https://push.example.test", keys: { p256dh: "p", auth: "a" } }),
            unsubscribe: vi.fn().mockResolvedValue(true),
        };
        registration = {
            pushManager: {
                getSubscription: vi.fn().mockResolvedValue(null),
                subscribe: vi.fn().mockResolvedValue(subscription),
            },
        };
        vi.stubGlobal("Notification", {
            permission: "default",
            requestPermission: vi.fn().mockResolvedValue("granted"),
        });
        Object.defineProperty(window, "PushManager", { configurable: true, value: function PushManager() {} });
        Object.defineProperty(navigator, "serviceWorker", {
            configurable: true,
            value: {
                register: vi.fn().mockResolvedValue(registration),
                getRegistration: vi.fn().mockResolvedValue(registration),
            },
        });
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
        i18n.changeLanguage("en");
        localStorage.clear();
    });

    it("asks for permission only after a click and saves the authenticated user's subscription", async () => {
        const { getByRole, findByText } = render(<PushSubscriptionControl />);

        fireEvent.click(getByRole("button", { name: "Enable browser notifications" }));

        expect(await findByText("Browser notifications are enabled on this device.")).toBeInTheDocument();
        expect(Notification.requestPermission).toHaveBeenCalledTimes(1);
        expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/service-worker.js");
        expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({
            userVisibleOnly: true,
            applicationServerKey: expect.any(Uint8Array),
        }));
        expect(mocks.registerPushSubscription).toHaveBeenCalledWith(subscription.toJSON());
        expect(localStorage.getItem("micopesa.pushSubscriptionId:worker-1")).toBe("sub-1");
    });

    it("removes the server subscription and browser subscription on request", async () => {
        localStorage.setItem("micopesa.pushSubscriptionId:worker-1", "sub-1");
        registration.pushManager.getSubscription.mockResolvedValue(subscription);
        const { getByRole, findByText } = render(<PushSubscriptionControl />);

        fireEvent.click(await screen.findByRole("button", { name: "Turn off browser notifications" }));

        expect(await findByText("Browser notifications are turned off on this device.")).toBeInTheDocument();
        expect(mocks.removePushSubscription).toHaveBeenCalledWith("sub-1");
        expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem("micopesa.pushSubscriptionId:worker-1")).toBeNull();
        expect(getByRole("button", { name: "Enable browser notifications" })).toBeInTheDocument();
    });
});
