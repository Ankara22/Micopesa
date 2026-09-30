import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE } from "../../routes/roleRoutes";
import "./auth.css";

const MIN_PASSWORD_LENGTH = 8;

// LOCAL DEVELOPMENT ONLY. Must match the backend's ALLOW_PRIVILEGED_SIGNUP
// flag. Never true in a production build.
const PRIVILEGED_SIGNUP_ENABLED = import.meta.env.VITE_ALLOW_PRIVILEGED_SIGNUP === "true";
const PRIVILEGED_ROLES = ["WORKER", "FUND_MANAGER", "REGULATOR", "ADMIN"];

function Register() {
    const { register } = useAuth();
    const navigate = useNavigate();

    const [fullName, setFullName] = useState("");
    const [phone, setPhone] = useState("");
    const [occupation, setOccupation] = useState("");
    const [role, setRole] = useState("WORKER");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    // Occupation is only required for WORKER accounts (they're the only
    // role that gets a pension account). In privileged dev-only signup
    // mode, a non-WORKER role makes occupation optional.
    const occupationRequired = !PRIVILEGED_SIGNUP_ENABLED || role === "WORKER";

    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");

        if (!fullName || !phone || !password || !confirmPassword) {
            setFormError("Full name, phone number, and password are required.");
            return;
        }

        if (occupationRequired && !occupation) {
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

        setIsSubmitting(true);
        const result = await register(
            fullName.trim(),
            phone.trim(),
            password,
            occupation,
            PRIVILEGED_SIGNUP_ENABLED ? role : undefined
        );
        setIsSubmitting(false);

        if (!result.success) {
            setFormError(result.message || "Registration failed. Please try again.");
            return;
        }

        const redirectTo = DASHBOARD_BY_ROLE[result.user.role] || "/";
        navigate(redirectTo, { replace: true });
    }

    return (
        <div className="auth-page">
            <form className="auth-card" onSubmit={handleSubmit} noValidate>
                <h1>Create your MicoPesa account</h1>
                <p className="auth-subtitle">Start saving toward your retirement</p>

                {formError && (
                    <div className="auth-error" role="alert">
                        {formError}
                    </div>
                )}

                <label htmlFor="full_name">Full name</label>
                <input
                    id="full_name"
                    name="full_name"
                    type="text"
                    autoComplete="name"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    disabled={isSubmitting}
                    required
                />

                <label htmlFor="phone">Phone number</label>
                <input
                    id="phone"
                    name="phone"
                    type="tel"
                    autoComplete="tel"
                    placeholder="+254700000000"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    disabled={isSubmitting}
                    required
                />

                {PRIVILEGED_SIGNUP_ENABLED && (
                    <>
                        <label htmlFor="role">
                            Role <span className="auth-dev-badge">Local dev only</span>
                        </label>
                        <select
                            id="role"
                            name="role"
                            value={role}
                            onChange={(e) => setRole(e.target.value)}
                            disabled={isSubmitting}
                        >
                            {PRIVILEGED_ROLES.map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                        </select>
                    </>
                )}

                <label htmlFor="occupation">
                    Occupation{!occupationRequired && " (optional)"}
                </label>
                <select
                    id="occupation"
                    name="occupation"
                    value={occupation}
                    onChange={(e) => setOccupation(e.target.value)}
                    disabled={isSubmitting}
                    required={occupationRequired}
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

                <label htmlFor="password">Password</label>
                <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                />

                <label htmlFor="confirm_password">Confirm password</label>
                <input
                    id="confirm_password"
                    name="confirm_password"
                    type="password"
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isSubmitting}
                    required
                    minLength={MIN_PASSWORD_LENGTH}
                />

                <button type="submit" className="auth-submit" disabled={isSubmitting}>
                    {isSubmitting ? "Creating account..." : "Create account"}
                </button>

                <p className="auth-footer">
                    Already have an account? <Link to="/login">Sign in</Link>
                </p>
            </form>
        </div>
    );
}

export default Register;
