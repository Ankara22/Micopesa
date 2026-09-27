import { Link } from "react-router-dom";
import "../components/ui/ui.css";

function Unauthorized() {
    return (
        <div className="unauthorized-page">
            <h1>Access denied</h1>
            <p>You don&apos;t have permission to view this page.</p>
            <Link to="/">Return home</Link>
        </div>
    );
}

export default Unauthorized;
