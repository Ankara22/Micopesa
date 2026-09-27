import { useState } from "react";
import { Outlet } from "react-router-dom";
import Header from "./Header";
import Sidebar from "./Sidebar";
import "./layout.css";

/** Shared shell for every authenticated page: header + sidebar + content. */
function AppLayout() {
    const [sidebarOpen, setSidebarOpen] = useState(false);

    return (
        <div className="app-shell">
            <Header onToggleSidebar={() => setSidebarOpen((prev) => !prev)} />
            <div className="app-body">
                <Sidebar open={sidebarOpen} onNavigate={() => setSidebarOpen(false)} />
                <main className="app-main">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

export default AppLayout;
