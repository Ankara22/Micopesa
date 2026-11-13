import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";

describe("API authentication error handling", () => {
    let originalAdapter;

    beforeEach(() => {
        localStorage.clear();
        originalAdapter = api.defaults.adapter;
    });

    afterEach(() => {
        api.defaults.adapter = originalAdapter;
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it("clears a matching invalid token and does not retry the request", async () => {
        localStorage.setItem("micopesa_token", "expired-token");
        const requestConfigs = [];
        api.defaults.adapter = vi.fn((config) => {
            requestConfigs.push(config);
            return Promise.reject({
                config,
                response: {
                    status: 401,
                    data: { message: "Your session has expired." },
                },
            });
        });
        const onInvalidSession = vi.fn();
        window.addEventListener("micopesa:auth-invalid", onInvalidSession);

        await expect(api.get("/protected")).rejects.toMatchObject({ status: 401 });
        expect(requestConfigs).toHaveLength(1);
        expect(requestConfigs[0].headers.Authorization).toBe("Bearer expired-token");
        expect(localStorage.getItem("micopesa_token")).toBeNull();
        expect(onInvalidSession).toHaveBeenCalledTimes(1);

        await expect(api.get("/protected")).rejects.toMatchObject({ status: 401 });
        expect(requestConfigs).toHaveLength(2);
        expect(requestConfigs[1].headers.Authorization).toBeUndefined();
        expect(onInvalidSession).toHaveBeenCalledTimes(1);
        window.removeEventListener("micopesa:auth-invalid", onInvalidSession);
    });

    it("does not clear a newer account token when an older request returns 401", async () => {
        localStorage.setItem("micopesa_token", "new-token");
        const requestConfigs = [];
        api.defaults.adapter = vi.fn((config) => {
            requestConfigs.push(config);
            return Promise.reject({
                config: {
                    ...config,
                    headers: { ...config.headers, Authorization: "Bearer old-token" },
                },
                response: { status: 401, data: { message: "Invalid authentication token" } },
            });
        });

        await expect(api.get("/protected")).rejects.toMatchObject({ status: 401 });
        expect(requestConfigs).toHaveLength(1);
        expect(localStorage.getItem("micopesa_token")).toBe("new-token");
    });

    it("keeps a newer session when a delayed 401 arrives for a request using the previous token", async () => {
        localStorage.setItem("micopesa_token", "old-session-token");
        const requestConfigs = [];
        let rejectRequest;
        api.defaults.adapter = vi.fn((config) => new Promise((_, reject) => {
            requestConfigs.push(config);
            rejectRequest = () => reject({
                config,
                response: {
                    status: 401,
                    data: { message: "Invalid authentication token" },
                },
            });
        }));

        const pendingRequest = api.get("/protected");
        await vi.waitFor(() => expect(requestConfigs).toHaveLength(1));
        expect(requestConfigs[0].headers.get("Authorization")).toBe("Bearer old-session-token");
        localStorage.setItem("micopesa_token", "new-session-token");
        rejectRequest();

        await expect(pendingRequest).rejects.toMatchObject({ status: 401 });
        expect(requestConfigs).toHaveLength(1);
        expect(localStorage.getItem("micopesa_token")).toBe("new-session-token");
    });
});
