import { useState } from "react";
import { useAuth } from "../context/AuthContext";
import { PROFILE_BY_ROLE, ROLE_LABEL } from "../routes/roleRoutes";
import Button from "../components/ui/Button";
import UserAvatar from "../components/UserAvatar";
import LanguageSwitcher from "../components/LanguageSwitcher";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import "./layout.css";

function Header({ onToggleSidebar, sidebarOpen, className = "" }) {
    const { user, logout } = useAuth();
    const { t } = useTranslation();
    const [loggingOut, setLoggingOut] = useState(false);

    async function handleLogout() {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            await logout();
        } finally {
            setLoggingOut(false);
        }
    }

    return (
        <header className={`app-header ${className}`.trim()}>
            <button
                type="button"
                className="sidebar-toggle"
                aria-label={t("header.toggleNavigation")}
                aria-controls="app-sidebar-navigation"
                aria-expanded={Boolean(sidebarOpen)}
                onClick={onToggleSidebar}
            >
                &#9776;
            </button>
            <div className="app-header-title">MicoPesa</div>
            <div className="app-header-user">
                <LanguageSwitcher />
                <Link
                    className="app-header-profile-link"
                    to={PROFILE_BY_ROLE[user?.role] || "/"}
                    aria-label={t("header.openProfile")}
                >
                    <UserAvatar user={user} className="app-header-avatar" />
                    <span className="app-header-user-name">{user?.full_name}</span>
                </Link>
                <span className="app-header-user-role">{t(`roles.${user?.role}`, { defaultValue: ROLE_LABEL[user?.role] || user?.role })}</span>
                <Button variant="secondary" size="sm" onClick={handleLogout} loading={loggingOut}>
                    {loggingOut ? t("header.loggingOut") : t("header.logOut")}
                </Button>
            </div>
        </header>
    );
}

export default Header;
