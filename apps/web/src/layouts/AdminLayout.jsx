import { useState } from "react";
import { Outlet } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";
import "./layout.css";

function AdminLayout() {
    const [sidebarOpen, setSidebarOpen] = useState(false);

    return (
        <div className="app-shell admin-shell">
            <Header
                className="admin-app-header"
                sidebarOpen={sidebarOpen}
                onToggleSidebar={() => setSidebarOpen((current) => !current)}
            />
            <div className="admin-body">
                <Sidebar
                    variant="admin"
                    open={sidebarOpen}
                    onNavigate={() => setSidebarOpen(false)}
                />
                <main className="admin-main">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

export default AdminLayout;
