import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { ROLE_LABEL } from "../routes/roleRoutes";
import Card from "./ui/Card";
import ErrorState from "./ui/ErrorState";
import SkeletonLoader from "./ui/SkeletonLoader";
import StatusBadge from "./ui/StatusBadge";
import "./ProfileCard.css";

const ROLE_DESCRIPTIONS = {
    WORKER: "Manage your personal account and access your savings tools.",
    ADMIN: "Manage your own account and access authorized platform administration tools.",
    FUND_MANAGER: "Manage your own account and access fund operations assigned to your role.",
    REGULATOR: "Manage your own account and access compliance oversight tools.",
};

const PROFILE_LINKS = {
    WORKER: [
        { label: "Contributions", to: "/worker/contributions", icon: "↗" },
        { label: "Retirement plan", to: "/worker/retirement-plan", icon: "◎" },
        { label: "Withdrawal history", to: "/worker/withdrawals", icon: "↘" },
    ],
    ADMIN: [
        { label: "User management", to: "/admin/users", icon: "♙" },
        { label: "Roles & permissions", to: "/admin/roles", icon: "◇" },
        { label: "System settings", to: "/admin/settings", icon: "⚙" },
    ],
    FUND_MANAGER: [
        { label: "Fund performance", to: "/manager/funds", icon: "▥" },
        { label: "Withdrawal requests", to: "/manager/withdrawal-requests", icon: "↘" },
        { label: "Operational reports", to: "/manager/reports", icon: "▤" },
    ],
    REGULATOR: [
        { label: "Compliance reports", to: "/regulator/compliance-reports", icon: "▤" },
        { label: "Audit logs", to: "/regulator/audit-logs", icon: "◷" },
        { label: "Fund oversight", to: "/regulator/funds", icon: "▥" },
    ],
};

function displayValue(value) {
    return typeof value === "string" && value.trim() ? value : "Not provided";
}

function formatDate(value) {
    if (!value) return "Not provided";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Not provided" : date.toLocaleDateString();
}

function getInitials(fullName) {
    const words = typeof fullName === "string" ? fullName.trim().split(/\s+/).filter(Boolean) : [];
    if (!words.length) return "?";
    return words.slice(0, 2).map((word) => word[0].toUpperCase()).join("");
}

function ProfileCard() {
    const { refreshUser } = useAuth();
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");

    useEffect(() => {
        let isMounted = true;
        refreshUser().then((savedProfile) => {
            if (!isMounted) return;
            if (!savedProfile) {
                setError("Your session changed while loading. Please try again.");
            } else {
                setProfile(savedProfile);
            }
        }).catch((loadError) => {
            if (isMounted) setError(loadError.message || "Unable to load your profile.");
        }).finally(() => {
            if (isMounted) setLoading(false);
        });

        return () => {
            isMounted = false;
        };
    }, [refreshUser]);

    async function loadProfile() {
        setLoading(true);
        setError("");
        try {
            const savedProfile = await refreshUser();
            if (!savedProfile) {
                throw new Error("Your session changed while loading. Please try again.");
            }
            setProfile(savedProfile);
        } catch (loadError) {
            setError(loadError.message || "Unable to load your profile.");
        } finally {
            setLoading(false);
        }
    }

    if (loading) {
        return <SkeletonLoader variant="chart" label="Loading your profile" />;
    }

    if (error) {
        return <ErrorState message={error} onRetry={loadProfile} />;
    }

    const role = profile.role;
    const roleLabel = ROLE_LABEL[role] || displayValue(role);
    const links = PROFILE_LINKS[role] || [];

    return (
        <div className="profile-content">
            <header className="profile-hero">
                <div className="profile-avatar" aria-hidden="true">{getInitials(profile.full_name)}</div>
                <div className="profile-hero-copy">
                    <p className="profile-eyebrow">Account profile</p>
                    <h1 className="profile-name">{displayValue(profile.full_name)}</h1>
                    <p className="profile-description">
                        {ROLE_DESCRIPTIONS[role] || "View your personal account information."}
                    </p>
                </div>
                <div className="profile-badges" aria-label="Role and account status">
                    <span className="badge badge-blue">{roleLabel}</span>
                    {profile.account_status
                        ? <StatusBadge status={profile.account_status} />
                        : <span className="badge badge-gray">Status not provided</span>}
                </div>
            </header>

            <div className="profile-grid">
                <Card title="Personal information" className="profile-card">
                    <dl className="profile-details">
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">♙</span>Full name</dt>
                            <dd>{displayValue(profile.full_name)}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">☎</span>Registered phone</dt>
                            <dd>{displayValue(profile.phone)}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">✉</span>Email address</dt>
                            <dd>{displayValue(profile.email)}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">▧</span>Occupation</dt>
                            <dd>{displayValue(profile.occupation)}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">◇</span>Account role</dt>
                            <dd>{roleLabel}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">●</span>Account status</dt>
                            <dd>
                                {profile.account_status
                                    ? <StatusBadge status={profile.account_status} />
                                    : "Not provided"}
                            </dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">◷</span>Member since</dt>
                            <dd>{formatDate(profile.created_at)}</dd>
                        </div>
                    </dl>
                    <p className="profile-readonly-note">
                        Profile details are read-only. Self-service profile editing is not currently available.
                    </p>
                </Card>

                <Card title="Your account tools" className="profile-card profile-tools-card">
                    <p className="profile-tools-intro">
                        Shortcuts to features available for your {roleLabel.toLowerCase()} account.
                    </p>
                    <nav className="profile-links" aria-label="Profile account tools">
                        {links.map((link) => (
                            <Link className="profile-link" to={link.to} key={link.to}>
                                <span className="profile-link-icon" aria-hidden="true">{link.icon}</span>
                                <span>{link.label}</span>
                                <span className="profile-link-arrow" aria-hidden="true">→</span>
                            </Link>
                        ))}
                    </nav>
                    {role === "WORKER" && (
                        <p className="profile-privacy-note">
                            Your balances and transaction details remain in their dedicated account pages.
                        </p>
                    )}
                </Card>
            </div>
        </div>
    );
}

export default ProfileCard;
