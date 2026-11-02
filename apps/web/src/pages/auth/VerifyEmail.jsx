import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import AuthLayout from "./AuthLayout";
import { verifyEmail } from "../../services/authEmailApi";
import { useTranslation } from "react-i18next";
import "./auth.css";

function VerifyEmail() {
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const token = searchParams.get("token") || "";
    const [state, setState] = useState(() => token
        ? { loading: true, success: false, error: false }
        : { loading: false, success: false, error: true });

    useEffect(() => {
        let current = true;
        if (!token) return () => { current = false; };
        verifyEmail(token).then(() => {
            if (current) setState({ loading: false, success: true, error: false });
        }).catch(() => {
            if (current) setState({ loading: false, success: false, error: true });
        });
        return () => { current = false; };
    }, [token]);

    return (
        <AuthLayout>
            <div className="auth-card">
                <p className="auth-eyebrow auth-card-eyebrow">{t("auth.verify.eyebrow")}</p>
                <h1>{t("auth.verify.title")}</h1>
                {state.loading && <p className="auth-subtitle" role="status">{t("auth.verify.loading")}</p>}
                {state.error && <div className="auth-error" role="alert">{t("auth.verify.invalidLink")}</div>}
                {state.success && <div className="auth-success" role="status">{t("auth.verify.success")}</div>}
                <p className="auth-footer"><Link to="/login">{t("auth.verify.returnSignIn")}</Link></p>
            </div>
        </AuthLayout>
    );
}

export default VerifyEmail;
