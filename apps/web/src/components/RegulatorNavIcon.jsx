const ICON_PATHS = {
    dashboard: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    analytics: "M4 19V5 M4 19h17 M8 15l4-4 3 2 5-6",
    funds: "M4 7h16 M4 12h16 M4 17h16 M7 4h10 M7 20h10",
    reports: "M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6",
    parameters: "M4 6h16 M4 12h16 M4 18h16 M8 4v4 M15 10v4 M10 16v4",
    kyc: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21a8 8 0 0 1 16 0 M17 11l2 2 4-4",
    audit: "M5 4h14v16H5z M8 8h8 M8 12h8 M8 16h5",
    notifications: "M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
    notificationAudit: "M4 5h16v14H4z M8 9h8 M8 13h5 M16 17l2 2 4-5",
    exports: "M12 3v12 M7 10l5 5 5-5 M4 20h16",
    history: "M3 12a9 9 0 1 0 2.64-6.36L3 8 M3 4v4h4 M12 7v5l3 2",
    profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M4 21a8 8 0 0 1 16 0",
};

function RegulatorNavIcon({ name }) {
    const path = ICON_PATHS[name];
    if (!path) return null;

    return (
        <svg className="regulator-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d={path} />
        </svg>
    );
}

export default RegulatorNavIcon;
