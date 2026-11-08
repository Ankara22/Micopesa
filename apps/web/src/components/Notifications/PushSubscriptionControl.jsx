import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "../../context/AuthContext";
import {
    getPushPublicKey,
    registerPushSubscription,
    removePushSubscription,
} from "../../services/notificationService";
import Button from "../ui/Button";

const STORAGE_PREFIX = "micopesa.pushSubscriptionId";

function decodeApplicationServerKey(value) {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const base64 = `${value.replace(/-/g, "+").replace(/_/g, "/")}${padding}`;
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function readSubscriptionId(storageKey) {
    try {
        return window.localStorage.getItem(storageKey);
    } catch {
        return null;
    }
}

function PushSubscriptionControl() {
    const { t } = useTranslation();
    const { user } = useAuth();
    const storageKey = `${STORAGE_PREFIX}:${user?.user_id || "current"}`;
    const [storedSubscription, setStoredSubscription] = useState(() => ({
        storageKey,
        subscriptionId: readSubscriptionId(storageKey),
    }));
    const subscriptionId = storedSubscription.storageKey === storageKey
        ? storedSubscription.subscriptionId
        : readSubscriptionId(storageKey);
    const [busy, setBusy] = useState(false);
    const [messageKey, setMessageKey] = useState("");

    async function enablePush() {
        if (busy) return;
        setBusy(true);
        setMessageKey("");
        let browserSubscription = null;
        let createdSubscription = false;
        try {
            if (!("serviceWorker" in navigator) ||
                !("PushManager" in window) ||
                !("Notification" in window)) {
                setMessageKey("worker.notifications.pushUnsupported");
                return;
            }
            const permission = Notification.permission === "granted"
                ? "granted"
                : await Notification.requestPermission();
            if (permission !== "granted") {
                setMessageKey("worker.notifications.pushPermissionDenied");
                return;
            }

            const registration = await navigator.serviceWorker.register("/service-worker.js");
            const publicKey = await getPushPublicKey();
            browserSubscription = await registration.pushManager.getSubscription();
            if (!browserSubscription) {
                browserSubscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: decodeApplicationServerKey(publicKey),
                });
                createdSubscription = true;
            }
            const savedId = await registerPushSubscription(browserSubscription.toJSON());
            try {
                window.localStorage.setItem(storageKey, savedId);
            } catch {
                await removePushSubscription(savedId);
                if (createdSubscription) await browserSubscription.unsubscribe();
                setMessageKey("worker.notifications.pushStorageError");
                return;
            }
            setStoredSubscription({ storageKey, subscriptionId: savedId });
            setMessageKey("worker.notifications.pushEnabled");
        } catch {
            if (createdSubscription && browserSubscription) {
                await browserSubscription.unsubscribe().catch(() => {});
            }
            setMessageKey("worker.notifications.pushError");
        } finally {
            setBusy(false);
        }
    }

    async function disablePush() {
        if (busy) return;
        setBusy(true);
        setMessageKey("");
        try {
            if (subscriptionId) {
                try {
                    await removePushSubscription(subscriptionId);
                } catch (error) {
                    if (error?.response?.status !== 404) throw error;
                }
            }
            const registration = await navigator.serviceWorker?.getRegistration("/service-worker.js");
            const subscription = await registration?.pushManager?.getSubscription();
            if (subscription) await subscription.unsubscribe();
            try {
                window.localStorage.removeItem(storageKey);
            } catch {
                setMessageKey("worker.notifications.pushStorageError");
                return;
            }
            setStoredSubscription({ storageKey, subscriptionId: null });
            setMessageKey("worker.notifications.pushDisabled");
        } catch {
            setMessageKey("worker.notifications.pushRemoveError");
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="section card" aria-labelledby="push-notifications-heading">
            <h2 className="card-title" id="push-notifications-heading">
                {t("worker.notifications.pushTitle")}
            </h2>
            <p className="page-subtitle">{t("worker.notifications.pushDescription")}</p>
            {messageKey && <p role="status">{t(messageKey)}</p>}
            {subscriptionId ? (
                <Button variant="secondary" loading={busy} onClick={disablePush}>
                    {t("worker.notifications.pushDisable")}
                </Button>
            ) : (
                <Button variant="primary" loading={busy} onClick={enablePush}>
                    {t("worker.notifications.pushEnable")}
                </Button>
            )}
        </section>
    );
}

export default PushSubscriptionControl;
