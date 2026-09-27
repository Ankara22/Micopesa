import "./ui.css";

/**
 * Simple accessible modal/dialog. Renders nothing when `open` is false.
 */
function Modal({ open, title, children, onClose }) {
    if (!open) return null;

    return (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
            <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
                <div className="modal-header">
                    <h2>{title}</h2>
                    <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
                        &times;
                    </button>
                </div>
                <div className="modal-body">{children}</div>
            </div>
        </div>
    );
}

export default Modal;
