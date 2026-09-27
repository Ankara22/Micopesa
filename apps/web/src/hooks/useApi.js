import { useState, useEffect } from "react";

/**
 * Generic data-fetching hook used by every page: wraps a fetcher function
 * with loading/error/data state and a refetch/mutate helper.
 *
 * @param {() => Promise<any>} fetcher - async function returning the data
 * @param {Array} deps - dependency array; the fetcher re-runs when these change
 */
function useApi(fetcher, deps = []) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    async function refetch() {
        setLoading(true);
        setError(null);
        try {
            const result = await fetcher();
            setData(result);
            return result;
        } catch (err) {
            setError(err.message || "Something went wrong");
            return null;
        } finally {
            setLoading(false);
        }
    }

    // `deps` is intentionally a caller-supplied, dynamic-length array (the
    // whole point of this generic hook), which the lint rule that requires
    // a literal array can't verify statically. Fetching data on mount/when
    // deps change (rather than in response to a user event) is the
    // canonical use case for an effect - disabling the newer, stricter
    // set-state-in-effect check here is intentional and safe.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        refetch();
        // eslint-disable-next-line
    }, deps);
    /* eslint-enable react-hooks/set-state-in-effect */

    return { data, setData, loading, error, refetch };
}

export default useApi;
