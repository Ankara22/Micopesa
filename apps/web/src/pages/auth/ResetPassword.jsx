import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { resetPassword } from "../../services/authEmailApi";
import { useTranslation } from "react-i18next";
import "./auth.css";

const MIN_PASSWORD_LENGTH = 8;

function ResetPassword() {
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const token = searchParams.get("token") || "";
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [success, setSuccess] = useState("");
    const [error, setError] = useState("");

    async function handleSubmit(event) {
        event.preventDefault();
        if (submitting) return;
        if (!token) {
            setError("auth.reset.invalidLink");
            return;
        }
        if (password.length < MIN_PASSWORD_LENGTH) {
            setError("auth.reset.passwordTooShort");
            return;
        }
        if (password !== confirmation) {
            setError("auth.reset.passwordMismatch");
            return;
        }
        setSubmitting(true);
        setError("");
        try {
            await resetPassword(token, password);
            setSuccess("auth.reset.success");
            setPassword("");
            setConfirmation("");
        } catch {
            setError("auth.reset.genericError");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.reset.eyebrow")}</p>
                <h1>{t("auth.reset.title")}</h1>
                <p className="auth-subtitle">{t("auth.reset.description")}</p>
                {error && <div className="auth-error" role="alert">{t(error, { count: MIN_PASSWORD_LENGTH })}</div>}
                {success && <div className="auth-success" role="status">{t(success)}</div>}
                {!success && (
                    <form className="auth-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
                        <div className="auth-field">
                            <label htmlFor="new-password">{t("auth.reset.newPassword")}</label>
                            <input id="new-password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD_LENGTH}
                                value={password} onChange={(event) => setPassword(event.target.value)} disabled={submitting} required />
                        </div>
                        <div className="auth-field">
                            <label htmlFor="confirm-new-password">{t("auth.reset.confirmPassword")}</label>
                            <input id="confirm-new-password" type="password" autoComplete="new-password"
                                value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={submitting} required />
                        </div>
                        <button className="auth-submit" type="submit" disabled={submitting || !token}>
                            {submitting ? t("auth.reset.submitting") : t("auth.reset.submit")}
                        </button>
                    </form>
                )}
                <p className="auth-footer">
                    {success ? <Link to="/login">{t("auth.reset.signIn")}</Link> : <Link to="/forgot-password">{t("auth.reset.requestAnother")}</Link>}
                </p>
            </div>
        </AuthLayout>
    );
}

export default ResetPassword;
