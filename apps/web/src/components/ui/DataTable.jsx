import "./ui.css";
import LoadingState from "./LoadingState";
import ErrorState from "./ErrorState";

/**
 * Generic data table.
 * @param {Array<{key: string, header: string, render?: (row) => ReactNode}>} columns
 * @param {Array<object>} rows
 * @param {string} rowKey - property name to use as the React key for each row
 */
function DataTable({ columns, rows, rowKey = "id", loading, error, onRetry, emptyMessage = "No records found." }) {
    if (loading) return <LoadingState />;
    if (error) return <ErrorState message={error} onRetry={onRetry} />;

    if (!rows || rows.length === 0) {
        return (
            <div className="state-block">
                <span>{emptyMessage}</span>
            </div>
        );
    }

    return (
        <div className="table-wrapper">
            <table className="data-table">
                <thead>
                    <tr>
                        {columns.map((col) => (
                            <th key={col.key}>{col.header}</th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row[rowKey]}>
                            {columns.map((col) => (
                                <td key={col.key}>{col.render ? col.render(row) : row[col.key]}</td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

export default DataTable;
