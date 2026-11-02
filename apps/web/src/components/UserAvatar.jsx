import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getMyProfilePhoto } from "../services/profileApi";

function getInitials(fullName) {
    const words = typeof fullName === "string" ? fullName.trim().split(/\s+/).filter(Boolean) : [];
    return words.length ? words.slice(0, 2).map((word) => word[0].toUpperCase()).join("") : "?";
}

function UserAvatar({ user, className = "", imageUrl: previewUrl = "" }) {
    const { t } = useTranslation();
    const [loadedPhoto, setLoadedPhoto] = useState(null);
    const [failedImageKey, setFailedImageKey] = useState(null);
    const photoVersion = user?.updated_at;
    const photoAvailable = user?.profile_photo_available;
    const photoKey = `${user?.user_id || ""}:${Boolean(photoAvailable)}:${photoVersion || ""}:${user?.profile_photo_version || 0}`;

    useEffect(() => {
        let isCurrent = true;
        let objectUrl = "";

        if (!previewUrl && photoAvailable) {
            getMyProfilePhoto()
                .then((blob) => {
                    if (!isCurrent) return;
                    objectUrl = URL.createObjectURL(blob);
                    setLoadedPhoto({ key: photoKey, status: "loaded", url: objectUrl });
                })
                .catch((error) => {
                    if (error.status !== 404) {
                        console.error("Failed to load profile photo:", error);
                    }
                    if (isCurrent) setLoadedPhoto({ key: photoKey, status: "failed" });
                });
        }

        return () => {
            isCurrent = false;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [photoAvailable, photoKey, previewUrl]);

    const name = user?.full_name || "User";
    const currentPhoto = loadedPhoto?.key === photoKey ? loadedPhoto : null;
    const loading = !previewUrl && Boolean(photoAvailable) && !currentPhoto;
    const imageKey = previewUrl ? `preview:${previewUrl}` : photoKey;
    const photoUrl = failedImageKey === imageKey
        ? ""
        : previewUrl || (currentPhoto?.status === "loaded" ? currentPhoto.url : "");
    return (
        <span
            className={`user-avatar ${className}`.trim()}
            role="img"
            aria-label={loading
                ? t("accessibility.loadingProfilePhoto", { name })
                : t("accessibility.profilePhoto", { name })}
            aria-busy={loading || undefined}
        >
            {photoUrl ? (
                <img
                    src={photoUrl}
                    alt=""
                    onError={() => {
                        setFailedImageKey(imageKey);
                        if (currentPhoto?.status === "loaded") {
                            URL.revokeObjectURL(currentPhoto.url);
                            setLoadedPhoto({ key: photoKey, status: "failed" });
                        }
                    }}
                />
            ) : (
                <>
                    <span aria-hidden="true">{getInitials(name)}</span>
                    {loading && <span className="user-avatar-progress" aria-hidden="true" />}
                </>
            )}
        </span>
    );
}

export default UserAvatar;
