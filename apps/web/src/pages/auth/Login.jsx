import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE, ROLE_PATH_PREFIX } from "../../routes/roleRoutes";
import AuthLayout from "./AuthLayout";
import { useTranslation } from "react-i18next";
import "./auth.css";

function Login() {
    const { login } = useAuth();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const location = useLocation();

    const [phone, setPhone] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const submissionInProgress = useRef(false);

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgress.current) return;
        setFormError("");

        const normalizedPhone = phone.trim();
        if (!normalizedPhone || !password) {
            setFormError("auth.login.phoneRequired");
            return;
        }

        submissionInProgress.current = true;
        setIsSubmitting(true);
        try {
            const result = await login(normalizedPhone, password);
            if (!result.success) {
                setFormError("auth.login.invalidCredentials");
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
                <p className="auth-subtitle">{t("auth.login.phonePrompt")}</p>

                {formError && (
                    <div className="auth-error" id="login-error" role="alert">
                        {t(formError)}
                    </div>
                )}

                <form className="auth-form" onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label htmlFor="login-phone">{t("auth.login.phone")}</label>
                        <input
                            id="login-phone"
                            name="phone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            placeholder={t("auth.login.phonePlaceholder")}
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
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
                    <button type="submit" className="auth-submit" disabled={isSubmitting}>
                        {isSubmitting ? t("auth.login.submitting") : t("auth.login.signIn")}
                    </button>
                </form>

                <p className="auth-footer">
                    {t("auth.login.newToMicoPesa")} <Link to="/register">{t("auth.login.createAccount")}</Link>
                </p>
            </div>
        </AuthLayout>
    );
}

export default Login;
