import { useState } from "react";
import { useNavigate } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { useAuth } from "../../context/AuthContext";
import { DASHBOARD_BY_ROLE } from "../../routes/roleRoutes";
import "./auth.css";

function ChangeTemporaryPassword() {
    const { changeTemporaryPassword } = useAuth();
    const navigate = useNavigate();
    const [password, setPassword] = useState("");
    const [confirmation, setConfirmation] = useState("");
    const [error, setError] = useState("");
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit(event) {
        event.preventDefault();
        setError("");
        if (password.length < 8) {
            setError("Choose a password with at least 8 characters.");
            return;
        }
        if (password !== confirmation) {
            setError("The passwords do not match.");
            return;
        }

        setSubmitting(true);
        try {
            const updatedUser = await changeTemporaryPassword(password);
            navigate(DASHBOARD_BY_ROLE[updatedUser.role] || "/", { replace: true });
        } catch (requestError) {
            setError(requestError.message || "Unable to update your password. Please try again.");
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">Account security</p>
                <h1>Set a new password</h1>
                <p className="auth-subtitle">
                    Your temporary staff password must be changed before you can use MicoPesa.
                </p>
                {error && <div className="auth-error" role="alert">{error}</div>}
                <form className="auth-form" onSubmit={handleSubmit}>
                    <div className="auth-field">
                        <label htmlFor="temporary-new-password">New password</label>
                        <input
                            id="temporary-new-password"
                            type="password"
                            autoComplete="new-password"
                            minLength={8}
                            value={password}
                            onChange={(event) => setPassword(event.target.value)}
                            disabled={submitting}
                            required
                        />
                    </div>
                    <div className="auth-field">
                        <label htmlFor="temporary-confirm-password">Confirm new password</label>
                        <input
                            id="temporary-confirm-password"
                            type="password"
                            autoComplete="new-password"
                            minLength={8}
                            value={confirmation}
                            onChange={(event) => setConfirmation(event.target.value)}
                            disabled={submitting}
                            required
                        />
                    </div>
                    <button className="auth-submit" type="submit" disabled={submitting}>
                        {submitting ? "Updating…" : "Update password"}
                    </button>
                </form>
            </div>
        </AuthLayout>
    );
}

export default ChangeTemporaryPassword;
