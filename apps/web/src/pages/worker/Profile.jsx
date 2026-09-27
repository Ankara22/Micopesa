import ProfileCard from "../../components/ProfileCard";

function Profile() {
    return (
        <div>
            <div className="page-header">
                <div>
                    <h1 className="page-title">Profile</h1>
                    <p className="page-subtitle">Your account details.</p>
                </div>
            </div>
            <ProfileCard />
        </div>
    );
}

export default Profile;
