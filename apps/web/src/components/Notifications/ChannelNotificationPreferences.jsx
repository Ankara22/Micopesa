import { useState } from "react";
import { useTranslation } from "react-i18next";
import useApi from "../../hooks/useApi";
import {
    getMyNotificationPreferences,
    updateMyNotificationPreferences,
} from "../../services/notificationService";
import Button from "../ui/Button";

function ChannelNotificationPreferences() {
    const { t } = useTranslation();
    const preferencesApi = useApi(getMyNotificationPreferences, []);
    const [changes, setChanges] = useState({});
    const [saving, setSaving] = useState(false);
    const [messageKey, setMessageKey] = useState("");

    const preferences = preferencesApi.data;
    const values = preferences ? { ...preferences, ...changes } : null;
    const dirty = values && (
        values.sms_enabled !== preferences.sms_enabled ||
        values.email_enabled !== preferences.email_enabled
    );

    function setPreference(name, value) {
        setMessageKey("");
        setChanges((current) => ({ ...current, [name]: value }));
    }

    async function savePreferences() {
        if (!values || !dirty || saving) return;
        setSaving(true);
        setMessageKey("");
        try {
            const saved = await updateMyNotificationPreferences(values);
            preferencesApi.setData(saved);
            setChanges({});
            setMessageKey("worker.notifications.preferencesSaved");
        } catch {
            setMessageKey("worker.notifications.preferencesError");
        } finally {
            setSaving(false);
        }
    }

    return (
        <section className="section card" aria-labelledby="notification-preferences-heading">
            <h2 className="card-title" id="notification-preferences-heading">
                {t("worker.notifications.preferencesTitle")}
            </h2>
            <p className="page-subtitle">{t("worker.notifications.preferencesDescription")}</p>
            {preferencesApi.loading && preferences === null ? (
                <p role="status">{t("worker.common.loadingRecords")}</p>
            ) : preferencesApi.error && preferences === null ? (
                <div role="alert">
                    <p>{t("worker.notifications.preferencesLoadError")}</p>
                    <Button variant="secondary" onClick={preferencesApi.refetch}>
                        {t("worker.common.tryAgain")}
                    </Button>
                </div>
            ) : values ? (
                <>
                    {preferencesApi.error && (
                        <p role="alert">{t("worker.notifications.preferencesRefreshError")}</p>
                    )}
                    <label className="notification-preference-option">
                        <input
                            type="checkbox"
                            checked={values.email_enabled}
                            onChange={(event) => setPreference("email_enabled", event.target.checked)}
                            disabled={saving}
                        />
                        <span>{t("worker.notifications.emailPreference")}</span>
                    </label>
                    <label className="notification-preference-option">
                        <input
                            type="checkbox"
                            checked={values.sms_enabled}
                            onChange={(event) => setPreference("sms_enabled", event.target.checked)}
                            disabled={saving}
                        />
                        <span>{t("worker.notifications.smsPreference")}</span>
                    </label>
                    {messageKey && <p role={messageKey.endsWith("Error") ? "alert" : "status"}>{t(messageKey)}</p>}
                    <Button
                        variant="secondary"
                        loading={saving}
                        disabled={!dirty || saving}
                        onClick={savePreferences}
                    >
                        {t("worker.notifications.savePreferences")}
                    </Button>
                </>
            ) : null}
        </section>
    );
}

export default ChannelNotificationPreferences;
