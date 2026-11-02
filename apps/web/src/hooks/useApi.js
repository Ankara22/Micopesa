import { useState, useEffect, useRef } from "react";

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
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const mountedRef = useRef(false);
    const requestIdRef = useRef(0);
    const inFlightRef = useRef(null);
    const hasLoadedRef = useRef(false);

    async function refetch(force = false) {
        if (inFlightRef.current && !force) return inFlightRef.current;
        const requestId = ++requestIdRef.current;
        const isInitialLoad = !hasLoadedRef.current;
        if (mountedRef.current) {
            setLoading(isInitialLoad);
            setRefreshing(!isInitialLoad);
            setError(null);
        }
        const request = Promise.resolve().then(async () => {
            try {
                const result = await fetcher();
                if (mountedRef.current && requestId === requestIdRef.current) {
                    setData(result);
                    hasLoadedRef.current = true;
                    setError(null);
                }
                return result;
            } catch (err) {
                if (mountedRef.current && requestId === requestIdRef.current) {
                    setError(err.message || "Something went wrong");
                }
                return null;
            } finally {
                if (mountedRef.current && requestId === requestIdRef.current) {
                    setLoading(false);
                    setRefreshing(false);
                }
                if (inFlightRef.current === request) inFlightRef.current = null;
            }
        });
        inFlightRef.current = request;
        return request;
    }

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            requestIdRef.current += 1;
        };
    }, []);

    // `deps` is intentionally a caller-supplied, dynamic-length array (the
    // whole point of this generic hook), which the lint rule that requires
    // a literal array can't verify statically. Fetching data on mount/when
    // deps change (rather than in response to a user event) is the
    // canonical use case for an effect - disabling the newer, stricter
    // set-state-in-effect check here is intentional and safe.
    /* eslint-disable react-hooks/set-state-in-effect */
    useEffect(() => {
        hasLoadedRef.current = false;
        setData(null);
        setLoading(true);
        setRefreshing(false);
        setError(null);
        refetch(true);
        // eslint-disable-next-line
    }, deps);
    /* eslint-enable react-hooks/set-state-in-effect */

    return { data, setData, loading, refreshing, error, refetch };
}

export default useApi;
