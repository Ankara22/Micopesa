import { useAuth } from "../context/AuthContext";
import { ROLE_LABEL } from "../routes/roleRoutes";
import Button from "../components/ui/Button";
import "./layout.css";

function Header({ onToggleSidebar }) {
    const { user, logout } = useAuth();

    async function handleLogout() {
        await logout();
    }

    return (
        <header className="app-header">
            <button
                type="button"
                className="sidebar-toggle"
                aria-label="Toggle navigation menu"
                onClick={onToggleSidebar}
            >
                &#9776;
            </button>
            <div className="app-header-title">MicoPesa</div>
            <div className="app-header-user">
                <span className="app-header-user-name">{user?.full_name}</span>
                <span className="app-header-user-role">{ROLE_LABEL[user?.role] || user?.role}</span>
                <Button variant="secondary" size="sm" onClick={handleLogout}>
                    Log out
                </Button>
            </div>
        </header>
    );
}

export default Header;
