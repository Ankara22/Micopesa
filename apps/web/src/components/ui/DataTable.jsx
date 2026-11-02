import "./ui.css";
import SkeletonLoader from "./SkeletonLoader";
import ErrorState from "./ErrorState";
import LoadingState from "./LoadingState";

/**
 * Generic data table.
 * @param {Array<{key: string, header: string, render?: (row) => ReactNode}>} columns
 * @param {Array<object>} rows
 * @param {string} rowKey - property name to use as the React key for each row
 */
function DataTable({
    columns,
    rows,
    rowKey = "id",
    loading,
    refreshing,
    error,
    onRetry,
    emptyMessage = "No records found.",
    loadingLabel = "Loading records",
    refreshingLabel = "Refreshing records...",
    errorTitle = "Unable to load this data",
    retryLabel = "Try again",
    unexpectedDataMessage = "The service returned information in an unexpected format.",
}) {
    if (loading) {
        return <SkeletonLoader variant="table" count={5} label={loadingLabel} />;
    }
    if (error && rows == null) return (
        <ErrorState message={error} title={errorTitle} retryLabel={retryLabel} onRetry={onRetry} />
    );
    if (!Array.isArray(rows)) {
        return (
            <ErrorState
                message={error || unexpectedDataMessage}
                title={errorTitle}
                retryLabel={retryLabel}
                onRetry={onRetry}
            />
        );
    }

    if (rows.length === 0) {
        return (
            <>
                {refreshing && <LoadingState message={refreshingLabel} />}
                {error && <ErrorState message={error} title={errorTitle} retryLabel={retryLabel} onRetry={onRetry} />}
                <div className="state-block"><span>{emptyMessage}</span></div>
            </>
        );
    }

    return (
        <>
            {refreshing && <LoadingState message={refreshingLabel} />}
            {error && <ErrorState message={error} title={errorTitle} retryLabel={retryLabel} onRetry={onRetry} />}
            <div className="table-wrapper" aria-busy={Boolean(refreshing)}>
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
                                    <td key={col.key} data-label={col.header || undefined}>
                                        {col.render ? col.render(row) : row[col.key]}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

export default DataTable;
