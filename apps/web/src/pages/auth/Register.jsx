import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE } from "../../routes/roleRoutes";
import AuthLayout from "./AuthLayout";
import "./auth.css";

const MIN_PASSWORD_LENGTH = 8;

function Register() {
    const { register } = useAuth();
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
            setFormError("Full name, phone number, and password are required.");
            return;
        }

        if (!occupation) {
            setFormError("Occupation is required.");
            return;
        }

        if (password.length < MIN_PASSWORD_LENGTH) {
            setFormError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
            return;
        }

        if (password !== confirmPassword) {
            setFormError("Passwords do not match.");
            return;
        }

        submissionInProgress.current = true;
        setIsSubmitting(true);
        try {
            const result = await register(normalizedName, normalizedPhone, password, occupation);
            if (!result.success) {
                setFormError(result.message || "Unable to create your account. Please try again.");
                return;
            }

            const redirectTo = DASHBOARD_BY_ROLE[result.user.role] || "/";
            navigate(redirectTo, { replace: true });
        } catch {
            setFormError("Unable to create your account right now. Please try again.");
        } finally {
            submissionInProgress.current = false;
            setIsSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card auth-card-register">
                <p className="auth-eyebrow auth-card-eyebrow">Get started</p>
                <h1>Create account</h1>
                <p className="auth-subtitle">Set up your MicoPesa worker account.</p>

                {formError && (
                    <div className="auth-error" id="register-error" role="alert">
                        {formError}
                    </div>
                )}

                <form className="auth-form auth-register-form" onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label htmlFor="register-full-name">Full name</label>
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
                        <label htmlFor="register-phone">Phone number</label>
                        <input
                            id="register-phone"
                            name="phone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            placeholder="+254 700 000 000"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : undefined}
                            required
                        />
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-occupation">Occupation</label>
                        <select
                            id="register-occupation"
                            name="occupation"
                            value={occupation}
                            onChange={(e) => setOccupation(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "register-error" : undefined}
                            required
                        >
                            <option value="">Select your occupation</option>
                            <option value="BODA_BODA_OPERATOR">Boda boda operator</option>
                            <option value="MARKET_VENDOR">Market vendor</option>
                            <option value="JUA_KALI_ARTISAN">Jua kali artisan</option>
                            <option value="DOMESTIC_WORKER">Domestic worker</option>
                            <option value="CASUAL_LABOURER">Casual labourer</option>
                            <option value="SMALL_SCALE_FARMER">Small-scale farmer</option>
                            <option value="OTHER_INFORMAL_WORKER">Other informal worker</option>
                        </select>
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-password">Password</label>
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
                            Use at least {MIN_PASSWORD_LENGTH} characters.
                        </span>
                    </div>
                    <div className="auth-field">
                        <label htmlFor="register-confirm-password">Confirm password</label>
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
                        {isSubmitting ? "Creating account…" : "Create account"}
                    </button>
                </form>

                <p className="auth-footer">
                    Already registered? <Link to="/login">Sign in</Link>
                </p>
            </div>
        </AuthLayout>
    );
}

export default Register;
