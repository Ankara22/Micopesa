import "./ui.css";

function LoadingState({ message = "Loading..." }) {
    return (
        <div className="state-block" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{message}</span>
        </div>
    );
}

export default LoadingState;
