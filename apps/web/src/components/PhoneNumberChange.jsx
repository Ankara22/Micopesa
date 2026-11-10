import { useState } from "react";
import { useTranslation } from "react-i18next";
import { requestPhoneChange, verifyPhoneChange } from "../services/profileApi";
import Button from "./ui/Button";

const ERROR_KEYS = {
    PHONE_CHANGE_PASSWORD_INVALID: "passwordInvalid",
    PHONE_CHANGE_INVALID_PHONE: "invalidPhone",
    PHONE_CHANGE_SAME_PHONE: "samePhone",
    PHONE_CHANGE_PHONE_IN_USE: "phoneInUse",
    PHONE_CHANGE_RATE_LIMITED: "rateLimited",
    PHONE_CHANGE_INVALID_CODE: "invalidCode",
    PHONE_CHANGE_CODE_EXPIRED: "codeExpired",
    PHONE_CHANGE_CHALLENGE_NOT_FOUND: "challengeNotFound",
    PHONE_CHANGE_SMS_UNAVAILABLE: "smsUnavailable",
};

function PhoneNumberChange({ currentPhone, onVerified }) {
    const { t } = useTranslation();
    const [stage, setStage] = useState("request");
    const [newPhone, setNewPhone] = useState("");
    const [currentPassword, setCurrentPassword] = useState("");
    const [confirmed, setConfirmed] = useState(false);
    const [code, setCode] = useState("");
    const [pendingPhone, setPendingPhone] = useState("");
    const [working, setWorking] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [error, setError] = useState("");

    function errorMessage(requestError, fallbackKey) {
        const codeKey = requestError?.data?.code;
        return t(`phoneChange.${ERROR_KEYS[codeKey] || fallbackKey}`);
    }

    async function handleRequest(event) {
        event.preventDefault();
        if (working || !confirmed) return;
        setWorking(true);
        setError("");
        setFeedback("");
        try {
            const result = await requestPhoneChange({
                newPhone,
                currentPassword,
                confirmed: true,
            });
            setPendingPhone(result.phone);
            setCurrentPassword("");
            setCode("");
            setStage("verify");
            setFeedback(t("phoneChange.codeSent"));
        } catch (requestError) {
            setError(errorMessage(requestError, "requestFailed"));
        } finally {
            setWorking(false);
        }
    }

    async function handleVerify(event) {
        event.preventDefault();
        if (working) return;
        setWorking(true);
        setError("");
        setFeedback("");
        try {
            await verifyPhoneChange(code);
            await onVerified();
            setNewPhone("");
            setCode("");
            setConfirmed(false);
            setPendingPhone("");
            setStage("request");
            setFeedback(t("phoneChange.phoneUpdated"));
        } catch (verifyError) {
            setError(errorMessage(verifyError, "verifyFailed"));
        } finally {
            setWorking(false);
        }
    }

    return (
        <section className="phone-change" aria-labelledby="phone-change-title">
            <h2 id="phone-change-title">{t("phoneChange.title")}</h2>
            <p className="phone-change-current">
                <strong>{t("phoneChange.currentPhone")}</strong>{" "}
                <span>{currentPhone || t("phoneChange.notAvailable")}</span>
            </p>
            {stage === "request" ? (
                <form className="phone-change-form" onSubmit={handleRequest}>
                    <label htmlFor="phone-change-new">{t("phoneChange.newPhone")}</label>
                    <input
                        id="phone-change-new"
                        name="new_phone"
                        type="tel"
                        autoComplete="tel"
                        inputMode="tel"
                        maxLength={20}
                        value={newPhone}
                        onChange={(event) => {
                            setNewPhone(event.target.value);
                            setConfirmed(false);
                        }}
                        placeholder={t("phoneChange.phonePlaceholder")}
                        required
                        disabled={working}
                    />
                    <p className="form-field-hint">{t("phoneChange.phoneHint")}</p>
                    <label htmlFor="phone-change-password">{t("phoneChange.currentPassword")}</label>
                    <input
                        id="phone-change-password"
                        name="current_password"
                        type="password"
                        autoComplete="current-password"
                        value={currentPassword}
                        onChange={(event) => setCurrentPassword(event.target.value)}
                        required
                        disabled={working}
                    />
                    <label className="phone-change-confirm">
                        <input
                            type="checkbox"
                            checked={confirmed}
                            onChange={(event) => setConfirmed(event.target.checked)}
                            disabled={working}
                        />
                        <span>{t("phoneChange.confirm", { phone: newPhone.trim() || t("phoneChange.newNumber") })}</span>
                    </label>
                    <Button type="submit" loading={working} disabled={!confirmed}>
                        {t("phoneChange.sendCode")}
                    </Button>
                </form>
            ) : (
                <form className="phone-change-form" onSubmit={handleVerify}>
                    <p>{t("phoneChange.enterCode", { phone: pendingPhone })}</p>
                    <label htmlFor="phone-change-code">{t("phoneChange.code")}</label>
                    <input
                        id="phone-change-code"
                        name="code"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        maxLength={6}
                        value={code}
                        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                        required
                        disabled={working}
                    />
                    <Button type="submit" loading={working} disabled={code.length !== 6}>
                        {t("phoneChange.verify")}
                    </Button>
                    <Button
                        type="button"
                        variant="secondary"
                        disabled={working}
                        onClick={() => {
                            setStage("request");
                            setError("");
                            setFeedback("");
                            setCurrentPassword("");
                        }}
                    >
                        {t("phoneChange.changeRequest")}
                    </Button>
                </form>
            )}
            {feedback && <p className="form-success" role="status">{feedback}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <p className="form-field-hint">{t("phoneChange.privacyNote")}</p>
        </section>
    );
}

export default PhoneNumberChange;
