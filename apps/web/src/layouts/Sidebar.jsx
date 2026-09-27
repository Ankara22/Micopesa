import { NavLink } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ROLE_NAV } from "../routes/roleRoutes";
import "./layout.css";

/**
 * Role-aware sidebar. Only ever renders the menu items for the current
 * user's own role - a WORKER never sees the ADMIN/FUND_MANAGER/REGULATOR
 * menu and vice versa.
 */
function Sidebar({ open, onNavigate }) {
    const { user } = useAuth();
    const items = ROLE_NAV[user?.role] || [];

    return (
        <aside className={`app-sidebar ${open ? "open" : ""}`.trim()}>
            <nav aria-label="Main navigation">
                <ul>
                    {items.map((item) => (
                        <li key={item.path}>
                            <NavLink
                                to={item.path}
                                className={({ isActive }) => (isActive ? "active" : "")}
                                onClick={onNavigate}
                                end
                            >
                                {item.label}
                            </NavLink>
                        </li>
                    ))}
                </ul>
            </nav>
        </aside>
    );
}

export default Sidebar;
