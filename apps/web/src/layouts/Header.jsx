import { useAuth } from "../context/AuthContext";
import { ROLE_LABEL } from "../routes/roleRoutes";
import Button from "../components/ui/Button";
import LanguageSwitcher from "../components/LanguageSwitcher";
import { useTranslation } from "react-i18next";
import "./layout.css";

function Header({ onToggleSidebar }) {
    const { user, logout } = useAuth();
    const { t } = useTranslation();

    async function handleLogout() {
        await logout();
    }

    return (
        <header className="app-header">
            <button
                type="button"
                className="sidebar-toggle"
                aria-label={t("header.toggleNavigation")}
                onClick={onToggleSidebar}
            >
                &#9776;
            </button>
            <div className="app-header-title">MicoPesa</div>
            <div className="app-header-user">
                <LanguageSwitcher />
                <span className="app-header-user-name">{user?.full_name}</span>
                <span className="app-header-user-role">{t(`roles.${user?.role}`, { defaultValue: ROLE_LABEL[user?.role] || user?.role })}</span>
                <Button variant="secondary" size="sm" onClick={handleLogout}>
                    {t("header.logOut")}
                </Button>
            </div>
        </header>
    );
}

export default Header;
