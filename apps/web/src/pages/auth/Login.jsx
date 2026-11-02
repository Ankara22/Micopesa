import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE, ROLE_PATH_PREFIX } from "../../routes/roleRoutes";
import { requestEmailVerificationForAddress } from "../../services/authEmailApi";
import AuthLayout from "./AuthLayout";
import { useTranslation } from "react-i18next";
import "./auth.css";

function Login() {
    const { t } = useTranslation();
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const [identifier, setIdentifier] = useState("");
    const [identifierType, setIdentifierType] = useState("email");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const [verificationMessage, setVerificationMessage] = useState("");
    const [verificationError, setVerificationError] = useState("");
    const [isRequestingVerification, setIsRequestingVerification] = useState(false);
    const submissionInProgress = useRef(false);

    async function handleRequestVerification() {
        if (isRequestingVerification) return;
        const normalizedEmail = identifier.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) return;
        setIsRequestingVerification(true);
        setVerificationMessage("");
        setVerificationError("");
        try {
            await requestEmailVerificationForAddress(normalizedEmail);
            setVerificationMessage("auth.login.verificationRequestAccepted");
        } catch {
            setVerificationError("auth.login.verificationRequestError");
        } finally {
            setIsRequestingVerification(false);
        }
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgress.current) return;
        setFormError("");

        const normalizedIdentifier = identifier.trim();
        if (!normalizedIdentifier || !password) {
            setFormError(identifierType === "email" ? "auth.login.emailRequired" : "auth.login.phoneRequired");
            return;
        }

        submissionInProgress.current = true;
        setIsSubmitting(true);
        try {
            const result = await login(normalizedIdentifier, password);
            if (!result.success) {
                if (result.status >= 500) {
                    setFormError("auth.login.serviceUnavailable");
                } else if (result.status === null) {
                    setFormError("auth.login.connectionError");
                } else {
                    setFormError("auth.login.invalidCredentials");
                }
                return;
            }

            if (result.user.force_password_change) {
                navigate("/change-password", { replace: true });
                return;
            }

            // Only honor a remembered destination belonging to the role that
            // authenticated, then fall back to that role's dashboard.
            const rememberedPath = location.state?.from?.pathname;
            const rolePrefix = ROLE_PATH_PREFIX[result.user.role];
            const redirectTo =
                (rememberedPath && rolePrefix && rememberedPath.startsWith(rolePrefix)
                    ? rememberedPath
                    : null) ||
                DASHBOARD_BY_ROLE[result.user.role] ||
                "/";
            navigate(redirectTo, { replace: true });
        } catch {
            setFormError("auth.login.genericError");
        } finally {
            submissionInProgress.current = false;
            setIsSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.login.welcome")}</p>
                <h1>{t("auth.login.title")}</h1>
                <p className="auth-subtitle">
                    {identifierType === "email"
                        ? t("auth.login.emailDescription")
                        : t("auth.login.phoneDescription")}
                </p>

                {formError && (
                    <div className="auth-error" id="login-error" role="alert">
                        {t(formError)}
                    </div>
                )}

                <form className="auth-form" onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
                    <div className="auth-field">
                        <label htmlFor="login-identifier">{t(identifierType === "email" ? "auth.login.email" : "auth.login.phone")}</label>
                        <input
                            id="login-identifier"
                            name="identifier"
                            type={identifierType === "email" ? "email" : "tel"}
                            autoComplete={identifierType === "email" ? "email" : "tel"}
                            placeholder={t(identifierType === "email" ? "auth.login.emailPlaceholder" : "auth.login.phonePlaceholder")}
                            value={identifier}
                            onChange={(e) => setIdentifier(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "login-error" : undefined}
                            required
                        />
                    </div>
                    <div className="auth-field">
                        <label htmlFor="login-password">{t("auth.login.password")}</label>
                        <input
                            id="login-password"
                            name="password"
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "login-error" : undefined}
                            required
                        />
                    </div>
                    <button type="submit" className="auth-submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                        {isSubmitting ? t("auth.login.submitting") : t("auth.login.signIn")}
                    </button>
                </form>

                <p className="auth-footer">
                    <button
                        type="button"
                        className="auth-link-button"
                        onClick={() => {
                            setIdentifierType((current) => current === "email" ? "phone" : "email");
                            setIdentifier("");
                            setFormError("");
                            setVerificationMessage("");
                            setVerificationError("");
                        }}
                    >
                        {t(identifierType === "email" ? "auth.login.switchToPhone" : "auth.login.switchToEmail")}
                    </button>
                </p>
                {identifierType === "email" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier.trim()) && (
                    <div className="auth-footer">
                        <button className="auth-link-button" type="button" onClick={handleRequestVerification} disabled={isRequestingVerification}>
                            {isRequestingVerification ? t("auth.login.requesting") : t("auth.login.resendVerification")}
                        </button>
                        {verificationMessage && <p role="status">{t(verificationMessage)}</p>}
                        {verificationError && <p role="alert">{t(verificationError)}</p>}
                    </div>
                )}
                <p className="auth-footer">
                    <Link to="/forgot-password">{t("auth.login.forgotPassword")}</Link>
                </p>
                <p className="auth-footer">
                    {t("auth.login.newToMicoPesa")} <Link to="/register">{t("auth.login.createAccount")}</Link>
                </p>
            </div>
        </AuthLayout>
    );
}

export default Login;
