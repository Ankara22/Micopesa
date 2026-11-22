import { useState } from "react";
import { Link } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { requestPasswordReset } from "../../services/authEmailApi";
import {
    completePhonePasswordReset,
    requestPhonePasswordReset,
} from "../../services/workerIdentityApi";
import { normalizeKenyanPhone } from "../../utils/kenyanPhone";
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
    const [phone, setPhone] = useState("");
    const [mode, setMode] = useState("EMAIL");
    const [stage, setStage] = useState("REQUEST");
    const [challengeId, setChallengeId] = useState("");
    const [code, setCode] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const supportLink = getOfficialSupportLink(import.meta.env.VITE_SUPPORT_CONTACT_URL);

    async function handleSubmit(event) {
        event.preventDefault();
        if (submitting) return;
        setSubmitting(true);
        setError("");
        setMessage("");
        try {
            if (mode === "EMAIL") {
                const normalized = email.trim();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
                    setError("auth.forgot.invalidEmail");
                    return;
                }
                await requestPasswordReset(normalized);
                setMessage("auth.forgot.genericSuccess");
                return;
            }

            const normalizedPhone = normalizeKenyanPhone(phone);
            if (!normalizedPhone) {
                setError("auth.forgot.invalidPhone");
                return;
            }
            const result = await requestPhonePasswordReset(normalizedPhone);
            const id = result?.data?.challenge_id;
            if (typeof id !== "string" || !id) {
                setError("auth.forgot.requestError");
                return;
            }
            setChallengeId(id);
            setStage("VERIFY");
            setMessage("auth.forgot.phoneCodeRequested");
        } catch {
            setError("auth.forgot.requestError");
        } finally {
            setSubmitting(false);
        }
    }

    async function handleCompletePhoneRecovery(event) {
        event.preventDefault();
        if (submitting) return;
        const cleanCode = code.replace(/\D/g, "").slice(0, 6);
        if (cleanCode.length !== 6) {
            setError("auth.forgot.invalidCode");
            return;
        }
        if (password.length < 8) {
            setError("auth.forgot.passwordTooShort");
            return;
        }
        if (new TextEncoder().encode(password).length > 72) {
            setError("auth.forgot.passwordTooLong");
            return;
        }
        if (password !== confirmPassword) {
            setError("auth.forgot.passwordMismatch");
            return;
        }

        setSubmitting(true);
        setError("");
        setMessage("");
        try {
            await completePhonePasswordReset({
                challengeId,
                phone: normalizeKenyanPhone(phone),
                code: cleanCode,
                password,
            });
            setStage("COMPLETE");
            setMessage("auth.forgot.phoneResetSuccess");
            setCode("");
            setPassword("");
            setConfirmPassword("");
        } catch {
            setError("auth.forgot.phoneResetError");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.forgot.eyebrow")}</p>
                <h1>{t("auth.forgot.title")}</h1>
                <p className="auth-subtitle">{t("auth.forgot.description")}</p>
                {mode === "EMAIL" && (
                    <p className="auth-footer">
                        {supportLink
                            ? <>{t("auth.forgot.officialSupport")} <a href={supportLink}>{t("auth.forgot.contactSupport")}</a></>
                            : t("auth.forgot.supportUnavailable")}
                    </p>
                )}
                {error && <div className="auth-error" role="alert">{t(error)}</div>}
                {message && <div className="auth-success" role="status">{t(message)}</div>}
                {stage === "REQUEST" && (
                    <form className="auth-form" onSubmit={handleSubmit} noValidate aria-busy={submitting}>
                        <div className="auth-field">
                            <label htmlFor={mode === "EMAIL" ? "recovery-email" : "recovery-phone"}>
                                {t(mode === "EMAIL" ? "auth.forgot.email" : "auth.forgot.phone")}
                            </label>
                            <input
                                id={mode === "EMAIL" ? "recovery-email" : "recovery-phone"}
                                type={mode === "EMAIL" ? "email" : "tel"}
                                inputMode={mode === "EMAIL" ? "email" : "tel"}
                                autoComplete={mode === "EMAIL" ? "email" : "tel"}
                                value={mode === "EMAIL" ? email : phone}
                                onChange={(event) => mode === "EMAIL"
                                    ? setEmail(event.target.value)
                                    : setPhone(event.target.value)}
                                disabled={submitting}
                                required
                            />
                        </div>
                        <button className="auth-submit" type="submit" disabled={submitting}>
                            {submitting ? t("auth.forgot.sending") : t(mode === "EMAIL"
                                ? "auth.forgot.request"
                                : "auth.forgot.requestPhoneCode")}
                        </button>
                    </form>
                )}
                {stage === "VERIFY" && (
                    <form className="auth-form" onSubmit={handleCompletePhoneRecovery} noValidate aria-busy={submitting}>
                        <div className="auth-field">
                            <label htmlFor="recovery-code">{t("auth.forgot.code")}</label>
                            <input
                                id="recovery-code"
                                type="text"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={6}
                                value={code}
                                onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                                disabled={submitting}
                                required
                            />
                        </div>
                        <div className="auth-field">
                            <label htmlFor="recovery-new-password">{t("auth.forgot.newPassword")}</label>
                            <input
                                id="recovery-new-password"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                disabled={submitting}
                                required
                            />
                        </div>
                        <div className="auth-field">
                            <label htmlFor="recovery-confirm-password">{t("auth.forgot.confirmPassword")}</label>
                            <input
                                id="recovery-confirm-password"
                                type="password"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(event) => setConfirmPassword(event.target.value)}
                                disabled={submitting}
                                required
                            />
                        </div>
                        <button className="auth-submit" type="submit" disabled={submitting}>
                            {submitting ? t("auth.forgot.resetting") : t("auth.forgot.resetPhonePassword")}
                        </button>
                    </form>
                )}
                <p className="auth-footer"><Link to="/login">{t("auth.forgot.returnSignIn")}</Link></p>
                {stage === "REQUEST" && (
                    <p className="auth-footer">
                        <button
                            type="button"
                            className="auth-link-button"
                            onClick={() => {
                                setMode((current) => current === "EMAIL" ? "PHONE" : "EMAIL");
                                setError("");
                                setMessage("");
                            }}
                            disabled={submitting}
                        >
                            {t(mode === "EMAIL" ? "auth.forgot.switchToPhone" : "auth.forgot.switchToEmail")}
                        </button>
                    </p>
                )}
            </div>
        </AuthLayout>
    );
}

export default ForgotPassword;
