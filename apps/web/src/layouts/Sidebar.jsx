import "../i18n";
import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ROLE_NAV } from "../routes/roleRoutes";
import { useTranslation } from "react-i18next";
import RegulatorNavIcon from "../components/RegulatorNavIcon";
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
    const pinnedAdminPaths = new Set(["/admin/audit-logs", "/admin/profile"]);
    const primaryItems = user?.role === "ADMIN"
        ? items.filter((item) => !pinnedAdminPaths.has(item.path))
        : items;
    const pinnedItems = user?.role === "ADMIN"
        ? items.filter((item) => pinnedAdminPaths.has(item.path))
        : [];
    const renderItem = (item) => (
        <li key={item.path}>
            <NavLink
                to={item.path}
                className={({ isActive }) => (isActive ? "active" : "")}
                onClick={onNavigate}
                end
            >
                {user?.role === "REGULATOR" && <RegulatorNavIcon name={item.icon} />}
                <span>{t(item.translationKey, { defaultValue: item.label })}</span>
            </NavLink>
        </li>
    );

    return (
        <aside className={`app-sidebar ${variant === "admin" ? "admin-sidebar" : variant ? `app-sidebar-${variant}` : ""} ${open ? "open" : ""}`.trim()}>
            <nav id="app-sidebar-navigation" aria-label={t("navigation.mainNavigation", { defaultValue: "Main navigation" })}>
                <ul className="app-sidebar-primary-list">{primaryItems.map(renderItem)}</ul>
                {pinnedItems.length > 0 && (
                    <ul className="app-sidebar-pinned-list" aria-label={t("navigation.pinnedAdminLinks")}>
                        {pinnedItems.map(renderItem)}
                    </ul>
                )}
            </nav>
        </aside>
    );
}

export default Sidebar;
