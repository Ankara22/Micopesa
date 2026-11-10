import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import AuthLayout from "./AuthLayout";
import { useTranslation } from "react-i18next";
import "./auth.css";

const REGISTRATION_ERROR_KEYS = {
    INVALID_NATIONAL_ID: "auth.register.invalidNationalId",
    INVALID_DATE_OF_BIRTH: "auth.register.invalidDateOfBirth",
    WORKER_AGE_OUT_OF_RANGE: "auth.register.workerAgeOutOfRange",
};

function getWorkerAge(dateOfBirth) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null;
    const [year, month, day] = dateOfBirth.split("-").map(Number);
    const birthDate = new Date(Date.UTC(year, month - 1, day));
    if (
        birthDate.getUTCFullYear() !== year ||
        birthDate.getUTCMonth() !== month - 1 ||
        birthDate.getUTCDate() !== day
    ) return null;

    const now = new Date();
    const currentYear = now.getUTCFullYear();
    const currentMonth = now.getUTCMonth();
    const currentDay = now.getUTCDate();
    if (birthDate > Date.UTC(currentYear, currentMonth, currentDay)) return null;

    let age = currentYear - year;
    if (currentMonth < month - 1 || (currentMonth === month - 1 && currentDay < day)) {
        age -= 1;
    }
    return age;
}

function Register() {
    const { register } = useAuth();
    const { t } = useTranslation();

    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [phone, setPhone] = useState("");
    const [nationalId, setNationalId] = useState("");
    const [dateOfBirth, setDateOfBirth] = useState("");
    const [occupation, setOccupation] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");
    const [fieldErrors, setFieldErrors] = useState({});
    const [registrationSubmitted, setRegistrationSubmitted] = useState(false);
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
        const normalizedNationalId = nationalId.trim();
        if (!normalizedNationalId) nextFieldErrors.nationalId = "auth.register.nationalIdRequired";
        else if (!/^\d{7,8}$/.test(normalizedNationalId)) {
            nextFieldErrors.nationalId = "auth.register.invalidNationalId";
        }
        const normalizedDateOfBirth = dateOfBirth.trim();
        const workerAge = getWorkerAge(normalizedDateOfBirth);
        if (!normalizedDateOfBirth) {
            nextFieldErrors.dateOfBirth = "auth.register.dateOfBirthRequired";
        } else if (workerAge === null) {
            nextFieldErrors.dateOfBirth = "auth.register.invalidDateOfBirth";
        } else if (workerAge < 18 || workerAge > 60) {
            nextFieldErrors.dateOfBirth = "auth.register.workerAgeOutOfRange";
        }
        setFieldErrors(nextFieldErrors);
        if (Object.values(nextFieldErrors).some(Boolean)) return;

        if (!occupation) {
            setFormError("auth.register.occupationRequired");
            return;
        }

        submissionInProgress.current = true;
        setIsSubmitting(true);
        try {
            const result = await register(
                normalizedName,
                normalizedEmail,
                normalizedPhone,
                occupation,
                normalizedNationalId,
                normalizedDateOfBirth,
            );
            if (!result.success) {
                setFormError(REGISTRATION_ERROR_KEYS[result.code] || "auth.register.createError");
                return;
            }
            setRegistrationSubmitted(true);
        } catch {
            setFormError("auth.register.genericError");
        } finally {
            submissionInProgress.current = false;
            setIsSubmitting(false);
        }
    }

    return (
        <AuthLayout variant="register">
            <div className="auth-card auth-card-register">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.register.eyebrow")}</p>
                <h1>{registrationSubmitted ? t("auth.register.verifyTitle") : t("auth.register.title")}</h1>
                <p className="auth-subtitle">
                    {registrationSubmitted
                        ? t("auth.register.verifyDescription")
                        : t("auth.register.description")}
                </p>

                {!registrationSubmitted && formError && (
                    <div className="auth-error" id="register-error" role="alert">
                        {t(formError)}
                    </div>
                )}

                {registrationSubmitted ? (
                    <section className="auth-form" aria-label={t("auth.register.verificationInstructions")}>
                        <div className="auth-success" role="status">
                            {t("auth.register.checkInbox")}
                        </div>
                        <p>{t("auth.register.setPasswordAfterVerification")}</p>
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
                        <label htmlFor="register-national-id">{t("auth.register.nationalId")}</label>
                        <input
                            id="register-national-id"
                            name="national_id"
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            value={nationalId}
                            onChange={(event) => {
                                setNationalId(event.target.value);
                                setFieldErrors((current) => ({ ...current, nationalId: "" }));
                            }}
                            disabled={isSubmitting}
                            aria-invalid={Boolean(fieldErrors.nationalId)}
                            aria-describedby={fieldErrors.nationalId ? "register-national-id-error" : "register-national-id-hint"}
                            required
                        />
                        <span id="register-national-id-hint" className="auth-field-hint">
                            {t("auth.register.nationalIdHint")}
                        </span>
                        {fieldErrors.nationalId && <span id="register-national-id-error" className="auth-field-hint" role="alert">{t(fieldErrors.nationalId)}</span>}
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-date-of-birth">{t("auth.register.dateOfBirth")}</label>
                        <input
                            id="register-date-of-birth"
                            name="date_of_birth"
                            type="date"
                            autoComplete="bday"
                            max={new Date().toISOString().slice(0, 10)}
                            value={dateOfBirth}
                            onChange={(event) => {
                                setDateOfBirth(event.target.value);
                                setFieldErrors((current) => ({ ...current, dateOfBirth: "" }));
                            }}
                            disabled={isSubmitting}
                            aria-invalid={Boolean(fieldErrors.dateOfBirth)}
                            aria-describedby={fieldErrors.dateOfBirth ? "register-date-of-birth-error" : undefined}
                            required
                        />
                        {fieldErrors.dateOfBirth && <span id="register-date-of-birth-error" className="auth-field-hint" role="alert">{t(fieldErrors.dateOfBirth)}</span>}
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
                    <button type="submit" className="auth-submit" disabled={isSubmitting} aria-busy={isSubmitting}>
                        {isSubmitting ? t("auth.register.submitting") : t("auth.register.create")}
                    </button>
                </form>}

                {!registrationSubmitted && <p className="auth-footer">
                    {t("auth.register.alreadyRegistered")} <Link to="/login">{t("auth.register.signIn")}</Link>
                </p>}
            </div>
        </AuthLayout>
    );
}

export default Register;
