import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE } from "../../routes/roleRoutes";
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

    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");

        if (!fullName || !phone || !occupation || !password || !confirmPassword) {
            setFormError("All fields are required.");
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
        const result = await register(fullName.trim(), phone.trim(), password, occupation);
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

                <label htmlFor="occupation">Occupation</label>
                <select
                    id="occupation"
                    name="occupation"
                    value={occupation}
                    onChange={(e) => setOccupation(e.target.value)}
                    disabled={isSubmitting}
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
