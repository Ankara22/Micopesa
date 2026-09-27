import { useAuth } from "../context/AuthContext";
import Card from "./ui/Card";
import "./ui/ui.css";

/**
 * Read-only profile summary shared by every role's Profile page. Data comes
 * straight from the authenticated session (GET /api/auth/me, already loaded
 * into AuthContext) - no extra API call needed. There is currently no
 * backend endpoint to edit a profile, so this is display-only.
 */
function ProfileCard() {
    const { user } = useAuth();

    return (
        <Card title="Your profile">
            <dl className="profile-list">
                <dt>Full name</dt>
                <dd>{user?.full_name}</dd>
                <dt>Phone</dt>
                <dd>{user?.phone}</dd>
                <dt>Role</dt>
                <dd>{user?.role}</dd>
                <dt>Occupation</dt>
                <dd>{user?.occupation || "-"}</dd>
                <dt>Account status</dt>
                <dd>{user?.account_status}</dd>
            </dl>
        </Card>
    );
}

export default ProfileCard;
