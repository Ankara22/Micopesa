import "../i18n";
import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ROLE_NAV } from "../routes/roleRoutes";
import { useTranslation } from "react-i18next";
import "./layout.css";

/**
 * Role-aware sidebar. Only ever renders the menu items for the current
 * user's own role - a WORKER never sees the ADMIN/FUND_MANAGER/REGULATOR
 * menu and vice versa.
 */
function Sidebar({ open, onNavigate, variant = "" }) {
    const { user } = useAuth();
    const { t } = useTranslation();
    const items = ROLE_NAV[user?.role] || [];

    return (
        <aside className={`app-sidebar ${variant === "admin" ? "admin-sidebar" : variant ? `app-sidebar-${variant}` : ""} ${open ? "open" : ""}`.trim()}>
            <nav id="app-sidebar-navigation" aria-label={t("navigation.mainNavigation", { defaultValue: "Main navigation" })}>
                <ul>
                    {items.map((item) => (
                        <li key={item.path}>
                            <NavLink
                                to={item.path}
                                className={({ isActive }) => (isActive ? "active" : "")}
                                onClick={onNavigate}
                                end
                            >
                                {t(item.translationKey, { defaultValue: item.label })}
                            </NavLink>
                        </li>
                    ))}
                </ul>
            </nav>
        </aside>
    );
}

export default Sidebar;
