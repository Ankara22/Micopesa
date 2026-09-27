import "./ui.css";
import Button from "./Button";

function ErrorState({ message = "Something went wrong.", onRetry }) {
    return (
        <div className="state-block" role="alert">
            <span className="state-title">Unable to load this data</span>
            <span>{message}</span>
            {onRetry && (
                <Button variant="secondary" size="sm" onClick={onRetry}>
                    Try again
                </Button>
            )}
        </div>
    );
}

export default ErrorState;
