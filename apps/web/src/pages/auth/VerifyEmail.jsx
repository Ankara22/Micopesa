import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { verifyEmail } from "../../services/authEmailApi";
import { isWithinPasswordByteLimit, MAX_PASSWORD_BYTES } from "../../utils/passwordValidation";
import { useTranslation } from "react-i18next";
import "./auth.css";

const MIN_PASSWORD_LENGTH = 8;

function VerifyEmail() {
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const token = searchParams.get("token") || "";
    const flow = searchParams.get("flow");
    const isRegistration = flow === "registration";
    const isExistingVerification = flow === "email-verification";
    const hasValidFlow = isRegistration || isExistingVerification;
    const [state, setState] = useState(() => ({
        submitting: false,
        success: false,
        error: !token || !hasValidFlow,
        registrationUnavailable: false,
        nextStep: null,
    }));
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [formError, setFormError] = useState("");

    async function handleEmailVerification(event) {
        event.preventDefault();
        if (state.submitting) return;
        setState((current) => ({ ...current, submitting: true }));
        try {
            const result = await verifyEmail(token);
            setState({
                submitting: false,
                success: true,
                error: false,
                registrationUnavailable: false,
                nextStep: result.next_step || null,
            });
        } catch {
            setState({
                submitting: false,
                success: false,
                error: true,
                registrationUnavailable: false,
            });
        }
    }

    async function handleRegistrationVerification(event) {
        event.preventDefault();
        setFormError("");
        if (password.length < MIN_PASSWORD_LENGTH) {
            setFormError("auth.verify.passwordTooShort");
            return;
        }
        if (!isWithinPasswordByteLimit(password)) {
            setFormError("auth.verify.passwordTooLong");
            return;
        }
        if (password !== confirmPassword) {
            setFormError("auth.verify.passwordMismatch");
            return;
        }

        setState((current) => ({ ...current, submitting: true }));
        try {
            await verifyEmail(token, password);
            setPassword("");
            setConfirmPassword("");
            setState({
                submitting: false,
                success: true,
                error: false,
                registrationUnavailable: false,
                nextStep: null,
            });
        } catch (error) {
            if (error.response?.data?.code === "REGISTRATION_COMPLETION_UNAVAILABLE") {
                setState({
                    submitting: false,
                    success: false,
                    error: false,
                    registrationUnavailable: true,
                });
                return;
            }
            setState({
                submitting: false,
                success: false,
                error: true,
                registrationUnavailable: false,
            });
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.verify.eyebrow")}</p>
                <h1>{t("auth.verify.title")}</h1>
                {state.error && (
                    <div className="auth-error" role="alert">
                        {hasValidFlow ? t("auth.verify.invalidLink") : t("auth.verify.invalidFlow")}
                    </div>
                )}
                {state.registrationUnavailable && (
                    <div className="auth-error" role="alert">{t("auth.verify.registrationUnavailable")}</div>
                )}
                {state.success && (
                    <div className="auth-success" role="status">
                        {state.nextStep === "STAFF_SIGN_IN"
                            ? t("auth.verify.staffSuccess")
                            : t("auth.verify.success")}
                    </div>
                )}
                {isExistingVerification && token && !state.success && !state.error && (
                    <form className="auth-form" onSubmit={handleEmailVerification} noValidate aria-busy={state.submitting}>
                        <p className="auth-subtitle">{t("auth.verify.emailVerificationDescription")}</p>
                        <button type="submit" className="auth-submit" disabled={state.submitting}>
                            {state.submitting ? t("auth.verify.verifying") : t("auth.verify.verifyEmail")}
                        </button>
                    </form>
                )}
                {isRegistration && !state.success && !state.error && !state.registrationUnavailable && (
                    <form className="auth-form" onSubmit={handleRegistrationVerification} noValidate aria-busy={state.submitting}>
                        <p className="auth-subtitle">{t("auth.verify.registrationDescription")}</p>
                        {formError && <div className="auth-error" role="alert">{t(formError, { count: MIN_PASSWORD_LENGTH })}</div>}
                        <div className="auth-field">
                            <label htmlFor="registration-password">{t("auth.verify.newPassword")}</label>
                            <input
                                id="registration-password"
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                disabled={state.submitting}
                                required
                                minLength={MIN_PASSWORD_LENGTH}
                                maxLength={MAX_PASSWORD_BYTES}
                            />
                        </div>
                        <div className="auth-field">
                            <label htmlFor="registration-confirm-password">{t("auth.verify.confirmPassword")}</label>
                            <input
                                id="registration-confirm-password"
                                type="password"
                                autoComplete="new-password"
                                value={confirmPassword}
                                onChange={(event) => setConfirmPassword(event.target.value)}
                                disabled={state.submitting}
                                required
                                minLength={MIN_PASSWORD_LENGTH}
                                maxLength={MAX_PASSWORD_BYTES}
                            />
                        </div>
                        <button type="submit" className="auth-submit" disabled={state.submitting}>
                            {state.submitting ? t("auth.verify.submitting") : t("auth.verify.completeRegistration")}
                        </button>
                    </form>
                )}
                <p className="auth-footer"><Link to="/login">{t("auth.verify.returnSignIn")}</Link></p>
            </div>
        </AuthLayout>
    );
}

export default VerifyEmail;
