import { useRef, useState } from "react";
import useApi from "../../hooks/useApi";
import { getOperationalSettings, updateOperationalSettings } from "../../services/adminService";
import Button from "../../components/ui/Button";
import ErrorState from "../../components/ui/ErrorState";
import LoadingState from "../../components/ui/LoadingState";
import { useToast } from "../../components/ui/ToastContext";
import { AdminCard, AdminPage } from "../../components/AdminPage";

function SystemSettings() {
    const settingsApi = useApi(getOperationalSettings, []);
    const toast = useToast();
    const [editedSettings, setEditedSettings] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const submissionInProgressRef = useRef(false);
    const settings = editedSettings ?? settingsApi.data;

    function updateSetting(key, value) {
        setEditedSettings((current) => ({ ...(current ?? settingsApi.data), [key]: value }));
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (!settings || submissionInProgressRef.current) return;
        submissionInProgressRef.current = true;
        setSubmitting(true);
        try {
            const saved = await updateOperationalSettings(settings);
            setEditedSettings(saved);
            toast.success("System settings saved and recorded in the audit log.");
        } catch (error) {
            toast.error(error.message || "Failed to save system settings.");
        } finally {
            submissionInProgressRef.current = false;
            setSubmitting(false);
        }
    }

    const loading = settingsApi.loading && settingsApi.data === null;

    return (
        <AdminPage
            title="System settings"
            subtitle="Changes are recorded in the audit log. The growth assumption affects future worker forecasts."
        >
            <AdminCard title="Platform controls" description="Choose values within the supported operating ranges.">
                {loading ? (
                    <LoadingState message="Loading system settings..." />
                ) : settingsApi.error && settings === null ? (
                    <ErrorState message={settingsApi.error} onRetry={settingsApi.refetch} />
                ) : settings ? (
                    <form className="admin-stack" onSubmit={handleSubmit}>
                        {settingsApi.error && <ErrorState message={settingsApi.error} onRetry={settingsApi.refetch} />}
                        <div>
                            <label className="admin-field-label" htmlFor="growth-setting">
                                Assumed yearly growth percentage
                            </label>
                            <div className="admin-range-row">
                                <input
                                    id="growth-setting"
                                    type="range"
                                    min="1"
                                    max="20"
                                    step="0.1"
                                    value={settings.assumed_yearly_growth}
                                    onChange={(event) => updateSetting("assumed_yearly_growth", Number(event.target.value))}
                                    disabled={submitting}
                                />
                                <output className="admin-range-value" htmlFor="growth-setting">
                                    {Number(settings.assumed_yearly_growth).toFixed(1)}%
                                </output>
                            </div>
                            <p className="admin-hint">Allowed range: 1–20% per year. Existing saved forecasts are not rewritten.</p>
                        </div>

                        <div className="admin-grid">
                            <div>
                                <label className="admin-field-label" htmlFor="failed-login-setting">
                                    Account lockout threshold after wrong passwords
                                </label>
                                <div className="admin-range-row">
                                    <input
                                        id="failed-login-setting"
                                        type="range"
                                        min="3"
                                        max="10"
                                        step="1"
                                        value={settings.max_failed_login_attempts}
                                        onChange={(event) => updateSetting("max_failed_login_attempts", Number(event.target.value))}
                                        disabled={submitting}
                                    />
                                    <output className="admin-range-value" htmlFor="failed-login-setting">
                                        {settings.max_failed_login_attempts}
                                    </output>
                                </div>
                            </div>
                            <div>
                                <label className="admin-field-label" htmlFor="lockout-duration-setting">
                                    Account lockout duration in minutes
                                </label>
                                <div className="admin-range-row">
                                    <input
                                        id="lockout-duration-setting"
                                        type="range"
                                        min="5"
                                        max="60"
                                        step="1"
                                        value={settings.account_lockout_duration_minutes}
                                        onChange={(event) => updateSetting("account_lockout_duration_minutes", Number(event.target.value))}
                                        disabled={submitting}
                                    />
                                    <output className="admin-range-value" htmlFor="lockout-duration-setting">
                                        {settings.account_lockout_duration_minutes}
                                    </output>
                                </div>
                            </div>
                        </div>

                        <label className="admin-switch-row">
                            <input
                                type="checkbox"
                                checked={settings.require_otp_on_withdrawal}
                                onChange={(event) => updateSetting("require_otp_on_withdrawal", event.target.checked)}
                                disabled={submitting}
                            />
                            <span>
                                <strong>Ask for a one-time code on every withdrawal</strong>
                                <span className="admin-hint">
                                    M-Pesa payout dispatch is currently disabled; this setting is stored for the future verified payout flow.
                                </span>
                            </span>
                        </label>
                        <div>
                            <Button type="submit" variant="primary" loading={submitting} disabled={submitting}>
                                Save changes
                            </Button>
                        </div>
                    </form>
                ) : (
                    <ErrorState message="System settings are unavailable." onRetry={settingsApi.refetch} />
                )}
            </AdminCard>
        </AdminPage>
    );
}

export default SystemSettings;
