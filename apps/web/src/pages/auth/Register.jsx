import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { requestEmailVerificationForAddress } from "../../services/authEmailApi";
import AuthLayout from "./AuthLayout";
import { useTranslation } from "react-i18next";
import "./auth.css";

const MIN_PASSWORD_LENGTH = 8;

function Register() {
    const { register } = useAuth();
    const { t } = useTranslation();

    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [occupation, setOccupation] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const [fieldErrors, setFieldErrors] = useState({});
    const [registeredEmail, setRegisteredEmail] = useState("");
    const [verificationEmailSent, setVerificationEmailSent] = useState(null);
    const [verificationMessage, setVerificationMessage] = useState("");
    const [verificationError, setVerificationError] = useState("");
    const [isResending, setIsResending] = useState(false);
    const submissionInProgress = useRef(false);

    function validateEmail(value) {
        const normalized = value.trim().toLowerCase();
        return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
            ? ""
            : "auth.register.invalidEmail";
    }

    async function handleSubmit(event) {
        event.preventDefault();
        if (submissionInProgress.current) return;
        setFormError("");

        const normalizedName = fullName.trim();
        const normalizedEmail = email.trim().toLowerCase();
        const normalizedPhone = phone.trim();
        const nextFieldErrors = {};
        if (!normalizedName) nextFieldErrors.fullName = "auth.register.nameRequired";
        if (!normalizedEmail) nextFieldErrors.email = "auth.register.emailRequired";
        else nextFieldErrors.email = validateEmail(normalizedEmail);
        if (!normalizedPhone) nextFieldErrors.phone = "auth.register.phoneRequired";
        setFieldErrors(nextFieldErrors);
        if (Object.values(nextFieldErrors).some(Boolean) || !password || !confirmPassword) {
            setFormError(!password || !confirmPassword ? "auth.register.passwordRequired" : "");
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
            const result = await register(normalizedName, normalizedEmail, normalizedPhone, password, occupation);
            if (!result.success) {
                setFormError("auth.register.createError");
                return;
            }
            setRegisteredEmail(normalizedEmail);
            setVerificationEmailSent(
                typeof result.verificationEmailSent === "boolean" ? result.verificationEmailSent : null,
            );
        } catch {
            setFormError("auth.register.genericError");
        } finally {
            submissionInProgress.current = false;
            setIsSubmitting(false);
        }
    }

    async function handleResendVerification() {
        if (isResending || !registeredEmail) return;
        setIsResending(true);
        setVerificationMessage("");
        setVerificationError("");
        try {
            await requestEmailVerificationForAddress(registeredEmail);
            setVerificationMessage("auth.register.verificationRequestAccepted");
        } catch {
            setVerificationError("auth.register.verificationRequestError");
        } finally {
            setIsResending(false);
        }
    }

    return (
        <AuthLayout variant="register">
            <div className="auth-card auth-card-register">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.register.eyebrow")}</p>
                <h1>{registeredEmail ? t("auth.register.verifyTitle") : t("auth.register.title")}</h1>
                <p className="auth-subtitle">
                    {registeredEmail
                        ? t("auth.register.verifyDescription", { email: registeredEmail })
                        : t("auth.register.description")}
                </p>

                {!registeredEmail && formError && (
                    <div className="auth-error" id="register-error" role="alert">
                        {t(formError, { count: MIN_PASSWORD_LENGTH })}
                    </div>
                )}

                {registeredEmail ? (
                    <section className="auth-form" aria-label={t("auth.register.verificationInstructions")}>
                        {verificationEmailSent === false ? (
                            <div className="auth-error" role="alert">
                                {t("auth.register.deliveryFailed")}
                            </div>
                        ) : (
                            <div className="auth-success" role="status">
                                {verificationEmailSent === true
                                    ? t("auth.register.emailSent")
                                    : t("auth.register.checkInbox")}
                            </div>
                        )}
                        {verificationError && <div className="auth-error" role="alert">{t(verificationError)}</div>}
                        {verificationMessage && <div className="auth-success" role="status">{t(verificationMessage)}</div>}
                        <button className="auth-submit" type="button" onClick={handleResendVerification} disabled={isResending}>
                            {isResending ? t("auth.register.requesting") : t("auth.register.resend")}
                        </button>
                        <p className="auth-footer"><Link to="/login">{t("auth.register.continueSignIn")}</Link></p>
                    </section>
                ) : <form className="auth-form auth-register-form" onSubmit={handleSubmit} noValidate aria-busy={isSubmitting}>
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
                            aria-invalid={Boolean(fieldErrors.fullName)}
                            aria-describedby={fieldErrors.fullName ? "register-full-name-error" : undefined}
                            required
                        />
                        {fieldErrors.fullName && <span id="register-full-name-error" className="auth-field-hint" role="alert">{t(fieldErrors.fullName)}</span>}
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-email">{t("auth.register.email")}</label>
                        <input
                            id="register-email"
                            name="email"
                            type="email"
                            autoComplete="email"
                            inputMode="email"
                            value={email}
                            onChange={(event) => {
                                setEmail(event.target.value);
                                setFieldErrors((current) => ({ ...current, email: "" }));
                            }}
                            onBlur={() => setFieldErrors((current) => ({
                                ...current,
                                email: email.trim() ? validateEmail(email) : "auth.register.emailRequired",
                            }))}
                            disabled={isSubmitting}
                            aria-invalid={Boolean(fieldErrors.email)}
                            aria-describedby={fieldErrors.email ? "register-email-error" : undefined}
                            required
                        />
                        {fieldErrors.email && <span id="register-email-error" className="auth-field-hint" role="alert">{t(fieldErrors.email)}</span>}
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
                            aria-invalid={Boolean(fieldErrors.phone)}
                            aria-describedby={fieldErrors.phone ? "register-phone-error" : undefined}
                            required
                        />
                        {fieldErrors.phone && <span id="register-phone-error" className="auth-field-hint" role="alert">{t(fieldErrors.phone)}</span>}
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
                    <button type="submit" className="auth-submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                        {isSubmitting ? t("auth.register.submitting") : t("auth.register.create")}
                    </button>
                </form>}

                {!registeredEmail && <p className="auth-footer">
                    {t("auth.register.alreadyRegistered")} <Link to="/login">{t("auth.register.signIn")}</Link>
                </p>}
            </div>
        </AuthLayout>
    );
}

export default Register;
