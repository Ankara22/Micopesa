import { useEffect, useRef, useId } from "react";
import "./ui.css";

/**
 * Simple accessible modal/dialog. Renders nothing when `open` is false.
 */
function Modal({
    open,
    title,
    closeLabel = "Close",
    children,
    onClose,
    className = "",
    footer,
    size = "standard",
}) {
    const dialogRef = useRef(null);
    const onCloseRef = useRef(onClose);
    const titleId = useId();

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!open) return undefined;

        const previousOverflow = document.body.style.overflow;
        const previousFocus = document.activeElement;
        document.body.style.overflow = "hidden";
        dialogRef.current?.focus();

        function handleKeyDown(event) {
            if (event.key === "Escape") {
                event.stopPropagation();
                onCloseRef.current?.();
                return;
            }

            if (event.key !== "Tab" || !dialogRef.current) return;

            const focusable = [...dialogRef.current.querySelectorAll(
                'a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [contenteditable="true"], [tabindex]:not([tabindex="-1"])'
            )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
            if (!focusable.length) {
                event.preventDefault();
                dialogRef.current.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || active === dialogRef.current || !dialogRef.current.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
                event.preventDefault();
                first.focus();
            }
        }

        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            document.body.style.overflow = previousOverflow;
            if (previousFocus instanceof HTMLElement && document.contains(previousFocus)) {
                previousFocus.focus();
            }
        };
    }, [open]);

    if (!open) return null;

    return (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
            <div
                ref={dialogRef}
                className={`modal modal--${size} ${className}`.trim()}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
            >
                <div className="modal-header">
                    <h2 id={titleId}>{title}</h2>
                    <button type="button" className="modal-close" aria-label={closeLabel} onClick={onClose}>
                        &times;
                    </button>
                </div>
                <div className="modal-body">{children}</div>
                {footer && <div className="modal-footer">{footer}</div>}
            </div>
        </div>
    );
}

export default Modal;
