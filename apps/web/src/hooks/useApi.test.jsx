import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import useApi from "./useApi";

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("useApi loading behavior", () => {
    it("shows initial loading and then replaces it with successful data", async () => {
        const pending = deferred();
        const fetcher = vi.fn(() => pending.promise);
        const { result } = renderHook(() => useApi(fetcher, []));

        expect(result.current.loading).toBe(true);
        expect(result.current.data).toBeNull();
        await act(async () => pending.resolve([]));
        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.data).toEqual([]);
        expect(result.current.error).toBeNull();
    });

    it("preserves previous data while refreshing and reports refresh errors", async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce([{ id: "saved" }])
            .mockImplementationOnce(() => Promise.reject(new Error("Refresh failed")));
        const { result } = renderHook(() => useApi(fetcher, []));
        await waitFor(() => expect(result.current.data).toEqual([{ id: "saved" }]));

        await act(async () => {
            await result.current.refetch();
        });

        expect(result.current.data).toEqual([{ id: "saved" }]);
        expect(result.current.loading).toBe(false);
        expect(result.current.refreshing).toBe(false);
        expect(result.current.error).toBe("Refresh failed");
    });

    it("re-enters initial loading on retry after a failed first request", async () => {
        const retryRequest = deferred();
        const fetcher = vi.fn()
            .mockRejectedValueOnce(new Error("Initial request failed"))
            .mockReturnValueOnce(retryRequest.promise);
        const { result } = renderHook(() => useApi(fetcher, []));

        await waitFor(() => expect(result.current.error).toBe("Initial request failed"));
        let retry;
        act(() => {
            retry = result.current.refetch();
        });

        expect(result.current.loading).toBe(true);
        expect(result.current.refreshing).toBe(false);
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        await act(async () => retryRequest.resolve([{ id: "recovered" }]));
        await retry;
        expect(result.current.loading).toBe(false);
        expect(result.current.data).toEqual([{ id: "recovered" }]);
        expect(result.current.error).toBeNull();
    });

    it("deduplicates simultaneous refetches", async () => {
        const initial = deferred();
        const refreshed = deferred();
        const fetcher = vi.fn()
            .mockReturnValueOnce(initial.promise)
            .mockReturnValueOnce(refreshed.promise);
        const { result } = renderHook(() => useApi(fetcher, []));
        await act(async () => initial.resolve([{ id: "one" }]));
        await waitFor(() => {
            expect(result.current.data).toEqual([{ id: "one" }]);
            expect(result.current.loading).toBe(false);
        });

        let first;
        let second;
        act(() => {
            first = result.current.refetch();
            second = result.current.refetch();
        });
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
        expect(result.current.refreshing).toBe(true);
        await act(async () => refreshed.resolve([{ id: "two" }]));
        await first;
        await second;
        expect(result.current.data).toEqual([{ id: "two" }]);
    });

    it("discards stale results when the resource key changes", async () => {
        const first = deferred();
        const second = deferred();
        const fetcher = vi.fn((key) => key === "first" ? first.promise : second.promise);
        const { result, rerender } = renderHook(
            ({ resourceKey }) => useApi(() => fetcher(resourceKey), [resourceKey]),
            { initialProps: { resourceKey: "first" } }
        );
        await waitFor(() => expect(fetcher).toHaveBeenCalledWith("first"));

        rerender({ resourceKey: "second" });
        await waitFor(() => expect(fetcher).toHaveBeenCalledWith("second"));
        expect(result.current.data).toBeNull();
        expect(result.current.loading).toBe(true);

        await act(async () => first.resolve([{ owner: "previous session" }]));
        expect(result.current.data).toBeNull();
        await act(async () => second.resolve([{ owner: "current session" }]));
        await waitFor(() => expect(result.current.data).toEqual([{ owner: "current session" }]));
    });
});
