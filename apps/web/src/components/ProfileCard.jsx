import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import {
    getMyProfile,
    requestEmailVerification,
    updateMyProfile,
    uploadMyProfilePhoto,
} from "../services/profileApi";
import { ROLE_LABEL } from "../routes/roleRoutes";
import Card from "./ui/Card";
import ErrorState from "./ui/ErrorState";
import SkeletonLoader from "./ui/SkeletonLoader";
import StatusBadge from "./ui/StatusBadge";
import Button from "./ui/Button";
import UserAvatar from "./UserAvatar";
import PhoneNumberChange from "./PhoneNumberChange";
import { formatDate as formatLocaleDate } from "../i18n/formatters";
import "./ProfileCard.css";

const ROLE_DESCRIPTIONS = {
    WORKER: "Manage your personal account and access your savings tools.",
    ADMIN: "Manage your own account and access authorized platform administration tools.",
    FUND_MANAGER: "Manage your own account and access fund operations assigned to your role.",
    REGULATOR: "Manage your own account and access compliance oversight tools.",
};

const PROFILE_ERROR_MESSAGES = {
    sessionUnavailable: "Your session is no longer available. Please sign in again.",
    responseMismatch: "The profile response did not match your signed-in account.",
    loadError: "Unable to load your profile.",
};

const PROFILE_LINKS = {
    WORKER: [
        { key: "contributions", to: "/worker/contributions", icon: "↗" },
        { key: "retirement", to: "/worker/retirement-plan", icon: "◎" },
        { key: "withdrawals", to: "/worker/withdrawals", icon: "↘" },
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

function displayValue(value, fallback = "Not provided") {
    return typeof value === "string" && value.trim() ? value : fallback;
}

function formatDate(value, language, fallback) {
    return formatLocaleDate(value, language) || fallback;
}

function ProfileCard() {
    const { t, i18n } = useTranslation();
    const {
        user,
        loginSessionId,
        beginProfileRequest,
        isProfileRequestCurrent,
        syncProfile,
    } = useAuth();
    const [profile, setProfile] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [fullName, setFullName] = useState("");
    const [email, setEmail] = useState("");
    const [editingField, setEditingField] = useState("");
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [resendingVerification, setResendingVerification] = useState(false);
    const [photoVersion, setPhotoVersion] = useState(0);
    const photoInputRef = useRef(null);
    const savingRef = useRef(false);
    const uploadingRef = useRef(false);
    const [feedback, setFeedback] = useState("");
    const [actionError, setActionError] = useState("");
    const isWorker = user?.role === "WORKER";
    const profileText = (key, fallback) => isWorker
        ? t(`worker.profile.${key}`)
        : fallback;

    const loadProfile = useCallback(async ({ silent = false } = {}) => {
        const request = beginProfileRequest();
        if (!request) {
            setError("sessionUnavailable");
            setLoading(false);
            return;
        }
        if (!silent) setLoading(true);
        setError("");
        try {
            const savedProfile = await getMyProfile();
            if (!isProfileRequestCurrent(request)) return;
            if (savedProfile.user_id !== request.userId) {
                setError("responseMismatch");
                return;
            }
            if (!syncProfile(savedProfile, request)) return;
            setProfile(savedProfile);
            setFullName(savedProfile.full_name || "");
            setEmail(savedProfile.pending_email || savedProfile.email || "");
        } catch {
            if (isProfileRequestCurrent(request)) {
                setError("loadError");
            }
        } finally {
            if (isProfileRequestCurrent(request)) setLoading(false);
        }
    }, [beginProfileRequest, isProfileRequestCurrent, syncProfile]);

    useEffect(() => {
        let isCurrent = true;
        Promise.resolve().then(() => {
            if (isCurrent) loadProfile();
        });
        return () => {
            isCurrent = false;
        };
    }, [loadProfile, user?.user_id, loginSessionId]);

    async function handleProfileSubmit(field, event) {
        event.preventDefault();
        if (savingRef.current || uploadingRef.current || !editingField) return;
        const request = beginProfileRequest();
        if (!request) {
            setActionError("sessionUnavailable");
            return;
        }
        savingRef.current = true;
        setSaving(true);
        setFeedback("");
        setActionError("");
        try {
            const updates = field === "full_name" ? { full_name: fullName } : { email };
            const savedProfile = await updateMyProfile(updates);
            if (!isProfileRequestCurrent(request)) return;
            if (savedProfile.user_id !== request.userId) {
                setActionError("responseMismatch");
                return;
            }
            if (!syncProfile(savedProfile, request)) return;
            setProfile(savedProfile);
            setFullName(savedProfile.full_name || "");
            setEmail(savedProfile.pending_email || savedProfile.email || "");
            setEditingField("");
            setFeedback(field === "full_name"
                ? profileText("nameUpdated", "Full name updated.")
                : profileText("emailPending", "Email address saved as pending. Verify it before using it to sign in or recover your password."));
        } catch (saveError) {
            if (isProfileRequestCurrent(request)) {
                const serverMessage = saveError?.message;
                setActionError(field === "email" && serverMessage === "That email address is already in use"
                    ? profileText("emailInUse", "That email address is already in use.")
                    : field === "full_name" && serverMessage?.startsWith("Full name must be")
                        ? profileText("invalidName", "The name does not meet the requirements.")
                        : field === "full_name"
                            ? profileText("saveNameError", "Unable to save profile. Please try again.")
                            : profileText("saveEmailError", "Unable to save your email address. Please try again."));
            }
        } finally {
            savingRef.current = false;
            setSaving(false);
        }
    }

    async function handleResendVerification() {
        if (resendingVerification || saving || uploading) return;
        setResendingVerification(true);
        setFeedback("");
        setActionError("");
        try {
            await requestEmailVerification();
            setFeedback(t("worker.profile.verificationAccepted"));
        } catch {
            setActionError(profileText("resendError", "Unable to resend the verification email. Please try again."));
        } finally {
            setResendingVerification(false);
        }
    }

    async function handlePhotoSelection(event) {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || savingRef.current || uploadingRef.current) return;
        if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
            setActionError(profileText("chooseImage", "Choose a JPEG, PNG, or WebP image."));
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setActionError(profileText("photoSize", "Profile photos must be 5 MB or smaller."));
            return;
        }
        const request = beginProfileRequest();
        if (!request) {
            setActionError("sessionUnavailable");
            return;
        }
        uploadingRef.current = true;
        setUploading(true);
        setFeedback("");
        setActionError("");
        try {
            const savedProfile = await uploadMyProfilePhoto(file);
            if (!isProfileRequestCurrent(request)) return;
            if (savedProfile.user_id !== request.userId) {
                setActionError("responseMismatch");
                return;
            }
            if (!syncProfile(savedProfile, request, { photoUpdated: true })) return;
            setProfile(savedProfile);
            setPhotoVersion((version) => version + 1);
            setFeedback(profileText("photoUpdated", "Your profile photo has been updated."));
        } catch {
            if (isProfileRequestCurrent(request)) {
                setActionError(profileText("photoUploadError", "Unable to upload your profile photo. Please try again."));
            }
        } finally {
            uploadingRef.current = false;
            setUploading(false);
        }
    }

    if (loading || !profile || profile.user_id !== user?.user_id) {
        return <SkeletonLoader variant="profile" label={profileText("loading", "Loading your profile")} />;
    }

    if (error) {
        return <ErrorState
            message={isWorker
                ? t(`worker.profile.${error}`, { defaultValue: t("worker.profile.loadError") })
                : PROFILE_ERROR_MESSAGES[error] || error}
            title={isWorker ? t("worker.common.profileUnableToLoad") : "Unable to load this data"}
            retryLabel={isWorker ? t("worker.common.tryAgain") : "Try again"}
            onRetry={loadProfile}
        />;
    }

    const role = profile.role;
    const roleLabel = role === "WORKER"
        ? t("roles.WORKER")
        : ROLE_LABEL[role] || displayValue(role, profileText("notProvided", "Not provided"));
    const links = PROFILE_LINKS[role] || [];

    return (
        <div className="profile-content">
            <header className="profile-hero">
                <div className="profile-avatar-control">
                    <button
                        type="button"
                        className="profile-avatar-button"
                        aria-label={profileText("changePhoto", "Change profile photo")}
                        onClick={(event) => {
                            event.stopPropagation();
                            photoInputRef.current?.click();
                        }}
                        disabled={uploading || saving}
                    >
                        <UserAvatar
                            user={{ ...profile, profile_photo_version: photoVersion }}
                            className="profile-avatar"
                        />
                    </button>
                    <input
                        ref={photoInputRef}
                        className="profile-photo-input"
                        id="profile-photo"
                        name="photo"
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        onChange={handlePhotoSelection}
                        disabled={uploading || saving}
                        aria-label={profileText("choosePhoto", "Choose profile photo")}
                        tabIndex={-1}
                    />
                    {uploading && <span className="profile-upload-spinner" role="status">{profileText("uploading", "Uploading photo…")}</span>}
                </div>
                <div className="profile-hero-copy">
                    <p className="profile-eyebrow">{profileText("accountProfile", "Account profile")}</p>
                    <h1 className="profile-name">{displayValue(profile.full_name, profileText("notProvided", "Not provided"))}</h1>
                    <p className="profile-description">
                        {role === "WORKER" ? t("worker.profile.description") : ROLE_DESCRIPTIONS[role] || "View your personal account information."}
                    </p>
                </div>
                <div className="profile-badges" aria-label={profileText("roleAndStatus", "Role and account status")}>
                    <span className="badge badge-blue">{roleLabel}</span>
                    {profile.account_status
                        ? <StatusBadge
                            status={profile.account_status}
                            label={isWorker
                                ? t(`worker.common.statuses.${profile.account_status}`, { defaultValue: profile.account_status })
                                : profile.account_status}
                        />
                        : <span className="badge badge-gray">{profileText("statusNotProvided", "Status not provided")}</span>}
                </div>
            </header>

            <div className="profile-grid">
                <Card title={profileText("personalInfo", "Personal information")} className="profile-card">
                    <div className="profile-edit-fields">
                        <form className="profile-edit-field" onSubmit={(event) => handleProfileSubmit("full_name", event)}>
                            <label htmlFor="profile-full-name">{profileText("fullName", "Full name")}</label>
                            <div className="profile-input-row">
                                {editingField === "full_name" ? (
                                    <input
                                        id="profile-full-name"
                                        name="full_name"
                                        type="text"
                                        autoComplete="name"
                                        minLength={2}
                                        maxLength={100}
                                        value={fullName}
                                        onChange={(event) => setFullName(event.target.value)}
                                        disabled={saving || uploading}
                                        required
                                        autoFocus
                                    />
                                ) : (
                                    <span className="profile-field-value">{displayValue(profile.full_name)}</span>
                                )}
                                {editingField === "full_name" ? (
                                    <div className="profile-field-actions">
                                        <Button type="submit" size="sm" loading={saving} disabled={uploading}>{profileText("save", "Save")}</Button>
                                        <Button type="button" size="sm" variant="secondary" disabled={saving || uploading} onClick={() => {
                                            setFullName(profile.full_name || "");
                                            setEditingField("");
                                            setActionError("");
                                        }}>{profileText("cancel", "Cancel")}</Button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="profile-edit-toggle"
                                        aria-label={profileText("editName", "Edit full name")}
                                        onClick={() => {
                                            setFullName(profile.full_name || "");
                                            setEditingField("full_name");
                                            setActionError("");
                                            setFeedback("");
                                        }}
                                        disabled={saving || uploading}
                                    >+</button>
                                )}
                            </div>
                        </form>
                        <form className="profile-edit-field" onSubmit={(event) => handleProfileSubmit("email", event)}>
                            <label htmlFor="profile-email">{profileText("email", "Email address")}</label>
                            <div className="profile-input-row">
                                {editingField === "email" ? (
                                    <input
                                        id="profile-email"
                                        name="email"
                                        type="email"
                                        autoComplete="email"
                                        maxLength={254}
                                        value={email}
                                        onChange={(event) => setEmail(event.target.value)}
                                        onInvalid={(event) => {
                                            if (event.currentTarget.validity.typeMismatch) {
                                                setActionError(profileText("invalidEmail", "Enter a valid email address."));
                                            }
                                        }}
                                        disabled={saving || uploading}
                                        autoFocus
                                    />
                                ) : (
                                    <span className="profile-field-value">
                                        {displayValue(profile.pending_email || profile.email)}
                                    </span>
                                )}
                                {editingField === "email" ? (
                                    <div className="profile-field-actions">
                                        <Button type="submit" size="sm" loading={saving} disabled={uploading}>{profileText("save", "Save")}</Button>
                                        <Button type="button" size="sm" variant="secondary" disabled={saving || uploading} onClick={() => {
                                            setEmail(profile.pending_email || profile.email || "");
                                            setEditingField("");
                                            setActionError("");
                                        }}>{profileText("cancel", "Cancel")}</Button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        className="profile-edit-toggle"
                                        aria-label={profileText("editEmail", "Edit email address")}
                                        onClick={() => {
                                            setEmail(profile.pending_email || profile.email || "");
                                            setEditingField("email");
                                            setActionError("");
                                            setFeedback("");
                                        }}
                                        disabled={saving || uploading}
                                    >+</button>
                                )}
                            </div>
                            <p className="form-field-hint">
                                {profile.email_verified
                                    ? profileText("verifiedEmail", "Verified email. A new address will not be trusted until it is verified.")
                                    : profileText("unverifiedEmail", "Email is not verified yet and cannot be used to sign in or recover your password.")}
                            </p>
                            {profile.pending_email && (
                                <div className="profile-field-actions">
                                    <span className="form-field-hint">{profileText("verificationPending", "Verification pending for this address.")}</span>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        loading={resendingVerification}
                                        disabled={saving || uploading}
                                        onClick={handleResendVerification}
                                    >
                                        {profileText("resendVerification", "Resend verification")}
                                    </Button>
                                </div>
                            )}
                        </form>
                    </div>
                    {feedback && <p className="form-success" role="status">{feedback}</p>}
                    {actionError && (
                        <p className="form-error" role="alert">
                            {isWorker
                                ? t(`worker.profile.${actionError}`, { defaultValue: actionError })
                                : PROFILE_ERROR_MESSAGES[actionError] || actionError}
                        </p>
                    )}
                    <dl className="profile-details">
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">▧</span>{profileText("occupation", "Occupation")}</dt>
                            <dd>{profile.occupation
                                ? isWorker
                                    ? t(`auth.register.occupations.${profile.occupation}`, { defaultValue: profile.occupation })
                                    : profile.occupation
                                : profileText("notProvided", "Not provided")}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">◇</span>{profileText("accountRole", "Account role")}</dt>
                            <dd>{roleLabel}</dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">●</span>{profileText("accountStatus", "Account status")}</dt>
                            <dd>
                                {profile.account_status
                                    ? <StatusBadge
                                        status={profile.account_status}
                                        label={isWorker
                                            ? t(`worker.common.statuses.${profile.account_status}`, { defaultValue: profile.account_status })
                                            : profile.account_status}
                                    />
                                    : profileText("notProvided", "Not provided")}
                            </dd>
                        </div>
                        <div className="profile-detail">
                            <dt><span className="profile-detail-icon" aria-hidden="true">◷</span>{profileText("memberSince", "Member since")}</dt>
                            <dd>{formatDate(profile.created_at, i18n.language, profileText("notProvided", "Not provided"))}</dd>
                        </div>
                    </dl>
                    <PhoneNumberChange
                        currentPhone={profile.phone}
                        onVerified={() => loadProfile({ silent: true })}
                    />
                    <p className="profile-readonly-note">
                        {isWorker
                            ? t("worker.profile.readonlyNote")
                            : "Profile changes affect only your name, email, photo, and verified phone number. Your role, account status, and permissions cannot be changed here."}
                    </p>
                </Card>

                <Card title={profileText("accountTools", "Your account tools")} className="profile-card profile-tools-card">
                    <p className="profile-tools-intro">
                        {isWorker ? t("worker.profile.toolsIntro") : `Shortcuts to features available for your ${roleLabel.toLowerCase()} account.`}
                    </p>
                    <nav className="profile-links" aria-label={profileText("accountTools", "Profile account tools")}>
                        {links.map((link) => (
                            <Link className="profile-link" to={link.to} key={link.to}>
                                <span className="profile-link-icon" aria-hidden="true">{link.icon}</span>
                                <span>{isWorker ? t(`worker.profile.links.${link.key}`) : link.label}</span>
                                <span className="profile-link-arrow" aria-hidden="true">→</span>
                            </Link>
                        ))}
                    </nav>
                    {role === "WORKER" && (
                        <p className="profile-privacy-note">
                            {t("worker.profile.privacyNote")}
                        </p>
                    )}
                </Card>
            </div>
        </div>
    );
}

export default ProfileCard;
