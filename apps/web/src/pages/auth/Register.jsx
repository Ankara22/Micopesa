import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE } from "../../routes/roleRoutes";
import AuthLayout from "./AuthLayout";
import { useTranslation } from "react-i18next";
import "./auth.css";

const MIN_PASSWORD_LENGTH = 8;

function Register() {
    const { register } = useAuth();
    const { t } = useTranslation();
    const navigate = useNavigate();

    const [fullName, setFullName] = useState("");
    const [phone, setPhone] = useState("");
    const [occupation, setOccupation] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const submissionInProgress = useRef(false);

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgress.current) return;
        setFormError("");

        const normalizedName = fullName.trim();
        const normalizedPhone = phone.trim();
        if (!normalizedName || !normalizedPhone || !password || !confirmPassword) {
            setFormError("auth.register.requiredFields");
            return;
        }

        if (!occupation) {
            setFormError("auth.register.occupationRequired");
            return;
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            setFormError("auth.register.passwordTooShort");
            return;
        }

        if (password !== confirmPassword) {
            setFormError("auth.register.passwordMismatch");
            return;
        }

        submissionInProgress.current = true;
        setIsSubmitting(true);
        try {
            const result = await register(normalizedName, normalizedPhone, password, occupation);
            if (!result.success) {
                setFormError(result.message || "auth.register.createError");
                return;
            }

            const redirectTo = DASHBOARD_BY_ROLE[result.user.role] || "/";
            navigate(redirectTo, { replace: true });
        } catch {
            setFormError("auth.register.genericError");
        } finally {
            submissionInProgress.current = false;
            setIsSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card auth-card-register">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.register.eyebrow")}</p>
                <h1>{t("auth.register.title")}</h1>
                <p className="auth-subtitle">{t("auth.register.phoneDescription")}</p>

                {formError && (
                    <div className="auth-error" id="register-error" role="alert">
                        {t(formError, { count: MIN_PASSWORD_LENGTH })}
                    </div>
                )}

                <form className="auth-form auth-register-form" onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label htmlFor="register-full-name">{t("auth.register.fullName")}</label>
                        <input
                            id="register-full-name"
                            name="full_name"
                            type="text"
                            autoComplete="name"
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : undefined}
                            required
                        />
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-phone">{t("auth.register.phone")}</label>
                        <input
                            id="register-phone"
                            name="phone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            placeholder={t("auth.register.phonePlaceholder")}
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : undefined}
                            required
                        />
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-occupation">{t("auth.register.occupation")}</label>
                        <select
                            id="register-occupation"
                            name="occupation"
                            value={occupation}
                            onChange={(e) => setOccupation(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : undefined}
                            required
                        >
                            <option value="">{t("auth.register.selectOccupation")}</option>
                            <option value="BODA_BODA_OPERATOR">{t("auth.register.occupations.BODA_BODA_OPERATOR")}</option>
                            <option value="MARKET_VENDOR">{t("auth.register.occupations.MARKET_VENDOR")}</option>
                            <option value="JUA_KALI_ARTISAN">{t("auth.register.occupations.JUA_KALI_ARTISAN")}</option>
                            <option value="DOMESTIC_WORKER">{t("auth.register.occupations.DOMESTIC_WORKER")}</option>
                            <option value="CASUAL_LABOURER">{t("auth.register.occupations.CASUAL_LABOURER")}</option>
                            <option value="SMALL_SCALE_FARMER">{t("auth.register.occupations.SMALL_SCALE_FARMER")}</option>
                            <option value="OTHER_INFORMAL_WORKER">{t("auth.register.occupations.OTHER_INFORMAL_WORKER")}</option>
                        </select>
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-password">{t("auth.register.password")}</label>
                        <input
                            id="register-password"
                            name="password"
                            type="password"
                            autoComplete="new-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : "password-help"}
                            required
                            minLength={MIN_PASSWORD_LENGTH}
                        />
                        <span id="password-help" className="auth-field-hint">
                            {t("auth.register.passwordHint", { count: MIN_PASSWORD_LENGTH })}
                        </span>
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-confirm-password">{t("auth.register.confirmPassword")}</label>
                        <input
                            id="register-confirm-password"
                            name="confirm_password"
                            type="password"
                            autoComplete="new-password"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : undefined}
                            required
                            minLength={MIN_PASSWORD_LENGTH}
                        />
                    </div>
                    <button type="submit" className="auth-submit" disabled={isSubmitting}>
                        {isSubmitting ? t("auth.register.submitting") : t("auth.register.create")}
                    </button>
                </form>

                <p className="auth-footer">
                    {t("auth.register.alreadyRegistered")} <Link to="/login">{t("auth.register.signIn")}</Link>
                </p>
            </div>
        </AuthLayout>
    );
}

export default Register;
