import "./ui.css";

/**
 * Label + input/select/textarea wrapper for consistent form styling.
 * `as`: "input" (default) | "select" | "textarea"
 * For "select", pass `options` as an array of { value, label }.
 */
function FormField({ id, label, as = "input", options = [], hint, ...rest }) {
    return (
        <div className="form-field">
            <label htmlFor={id}>{label}</label>
            {as === "select" ? (
                <select id={id} name={id} {...rest}>
                    {options.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                            {opt.label}
                        </option>
                    ))}
                </select>
            ) : as === "textarea" ? (
                <textarea id={id} name={id} rows={4} {...rest} />
            ) : (
                <input id={id} name={id} {...rest} />
            )}
            {hint && <p className="form-field-hint">{hint}</p>}
        </div>
    );
}

export default FormField;
