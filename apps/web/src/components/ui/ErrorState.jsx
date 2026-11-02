import "./ui.css";
import Button from "./Button";

function ErrorState({
    message = "Something went wrong.",
    title = "Unable to load this data",
    retryLabel = "Try again",
    onRetry,
}) {
    return (
        <div className="state-block" role="alert">
            <span className="state-title">{title}</span>
            <span>{message}</span>
            {onRetry && (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                    {retryLabel}
                </Button>
            )}
        </div>
    );
}

export default ErrorState;
