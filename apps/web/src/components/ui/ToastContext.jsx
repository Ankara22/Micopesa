import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "./ui.css";

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
    const { t } = useTranslation();
    const [toasts, setToasts] = useState([]);

    const dismiss = useCallback((id) => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
    }, []);

    const notify = useCallback((message, type = "info") => {
        const id = `${Date.now()}-${Math.random()}`;
        setToasts((current) => [...current, { id, message, type }]);
        window.setTimeout(() => dismiss(id), 5000);
    }, [dismiss]);

    const value = useMemo(() => ({
        success: (message) => notify(message, "success"),
        error: (message) => notify(message, "error"),
        info: (message) => notify(message, "info"),
    }), [notify]);

    return (
        <ToastContext.Provider value={value}>
            {children}
            <div className="toast-viewport" aria-live="polite" aria-atomic="false">
                {toasts.map((toast) => (
                    <div className={`toast toast-${toast.type}`} key={toast.id} role={toast.type === "error" ? "alert" : "status"}>
                        <span>{toast.message}</span>
                        <button type="button" aria-label={t("accessibility.dismissNotification")} onClick={() => dismiss(toast.id)}>
                            &times;
                        </button>
                    </div>
                ))}
            </div>
        </ToastContext.Provider>
    );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
    const toast = useContext(ToastContext);
    if (!toast) throw new Error("useToast must be used within a ToastProvider");
    return toast;
}
