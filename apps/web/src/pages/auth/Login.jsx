import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE, ROLE_PATH_PREFIX } from "../../routes/roleRoutes";
import AuthLayout from "./AuthLayout";
import "./auth.css";

function Login() {
    const { login } = useAuth();
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
            setFormError("Phone number and password are required.");
            return;
        }

        submissionInProgress.current = true;
        setIsSubmitting(true);
        try {
            const result = await login(normalizedPhone, password);
            if (!result.success) {
                setFormError("We couldn't sign you in. Check your details or try again later.");
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
            setFormError("Unable to sign in right now. Please try again.");
        } finally {
            submissionInProgress.current = false;
            setIsSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">Welcome back</p>
                <h1>Sign in</h1>
                <p className="auth-subtitle">Use your registered phone number to continue.</p>

                {formError && (
                    <div className="auth-error" id="login-error" role="alert">
                        {formError}
                    </div>
                )}

                <form className="auth-form" onSubmit={handleSubmit} noValidate>
                    <div className="auth-field">
                        <label htmlFor="login-phone">Phone number</label>
                        <input
                            id="login-phone"
                            name="phone"
                            type="tel"
                            autoComplete="tel"
                            inputMode="tel"
                            placeholder="+254 700 000 000"
                            value={phone}
                            onChange={(e) => setPhone(e.target.value)}
                            disabled={isSubmitting}
                            aria-describedby={formError ? "login-error" : undefined}
                            required
                        />
                    </div>
                    <div className="auth-field">
                        <label htmlFor="login-password">Password</label>
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
                        {isSubmitting ? "Signing in…" : "Sign in"}
                    </button>
                </form>

                <p className="auth-footer">
                    New to MicoPesa? <Link to="/register">Create an account</Link>
                </p>
            </div>
        </AuthLayout>
    );
}

export default Login;
