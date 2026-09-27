import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE, ROLE_PATH_PREFIX } from "../../routes/roleRoutes";
import "./auth.css";

function Login() {
    const { login } = useAuth();
    const navigate = useNavigate();
    const location = useLocation();

    const [phone, setPhone] = useState("");
    const [password, setPassword] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [formError, setFormError] = useState("");

    async function handleSubmit(event) {
        event.preventDefault();
        setFormError("");

        if (!phone || !password) {
            setFormError("Phone number and password are required.");
            return;
        }

        setIsSubmitting(true);
        const result = await login(phone.trim(), password);
        setIsSubmitting(false);

        if (!result.success) {
            setFormError(result.message || "Login failed. Please try again.");
            return;
        }

        // Only honor a remembered "redirect back to" location if it actually
        // belongs to the role that just logged in - otherwise a location
        // remembered for a different user/role could bounce a correctly
        // authenticated user straight to /unauthorized instead of their
        // own dashboard.
        const rememberedPath = location.state?.from?.pathname;
        const rolePrefix = ROLE_PATH_PREFIX[result.user.role];
        const redirectTo =
            (rememberedPath && rolePrefix && rememberedPath.startsWith(rolePrefix)
                ? rememberedPath
                : null) ||
            DASHBOARD_BY_ROLE[result.user.role] ||
            "/";
        navigate(redirectTo, { replace: true });
    }

    return (
        <div className="auth-page">
            <form className="auth-card" onSubmit={handleSubmit} noValidate>
                <h1>Sign in to MicoPesa</h1>
                <p className="auth-subtitle">Access your pension account</p>

                {formError && (
                    <div className="auth-error" role="alert">
                        {formError}
                    </div>
                )}

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

                <label htmlFor="password">Password</label>
                <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                    required
                />

                <button type="submit" className="auth-submit" disabled={isSubmitting}>
                    {isSubmitting ? "Signing in..." : "Sign in"}
                </button>

                <p className="auth-footer">
                    Don&apos;t have an account? <Link to="/register">Register</Link>
                </p>
            </form>
        </div>
    );
}

export default Login;
