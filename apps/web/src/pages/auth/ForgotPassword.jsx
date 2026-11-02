import { useState } from "react";
import { Link } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { requestPasswordReset } from "../../services/authEmailApi";
import { useTranslation } from "react-i18next";
import "./auth.css";

function getOfficialSupportLink(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
        const url = new URL(value.trim());
        return ["https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

function ForgotPassword() {
    const { t } = useTranslation();
    const [email, setEmail] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const supportLink = getOfficialSupportLink(import.meta.env.VITE_SUPPORT_CONTACT_URL);

    async function handleSubmit(event) {
        event.preventDefault();
        if (submitting) return;
        const normalized = email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
            setError("auth.forgot.invalidEmail");
            return;
        }
        setSubmitting(true);
        setError("");
        setMessage("");
        try {
            await requestPasswordReset(normalized);
            setMessage("auth.forgot.genericSuccess");
        } catch {
            setError("auth.forgot.requestError");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.forgot.eyebrow")}</p>
                <h1>{t("auth.forgot.title")}</h1>
                <p className="auth-subtitle">
                    {t("auth.forgot.description")}
                </p>
                <p className="auth-footer">
                    {supportLink
                        ? <>{t("auth.forgot.officialSupport")} <a href={supportLink}>{t("auth.forgot.contactSupport")}</a></>
                        : t("auth.forgot.supportUnavailable")}
                </p>
                {error && <div className="auth-error" role="alert">{t(error)}</div>}
                {message && <div className="auth-success" role="status">{t(message)}</div>}
                <form className="auth-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
                    <div className="auth-field">
                        <label htmlFor="recovery-email">{t("auth.forgot.email")}</label>
                        <input
                            id="recovery-email"
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            disabled={submitting}
                            required
                        />
                    </div>
                    <button className="auth-submit" type="submit" disabled={submitting}>
                        {submitting ? t("auth.forgot.sending") : t("auth.forgot.request")}
                    </button>
                </form>
                <p className="auth-footer"><Link to="/login">{t("auth.forgot.returnSignIn")}</Link></p>
            </div>
        </AuthLayout>
    );
}

export default ForgotPassword;
