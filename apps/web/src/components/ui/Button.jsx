import "./ui.css";

/**
 * Generic button. variant: "primary" | "secondary" | "danger".
 * Pass `loading` to show a spinner and auto-disable the button.
 */
function Button({
    children,
    variant = "primary",
    size,
    loading = false,
    disabled = false,
    type = "button",
    onClick,
    ...rest
}) {
    const classNames = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : ""]
        .filter(Boolean)
        .join(" ");

    return (
        <button
            type={type}
            className={classNames}
            disabled={disabled || loading}
            onClick={onClick}
            {...rest}
        >
            {loading && <span className="btn-spinner" aria-hidden="true" />}
            {children}
        </button>
    );
}

export default Button;
