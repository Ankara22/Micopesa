import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "./api";
import {
    getFundAllocations,
    getMyAllocations,
    listAvailableFunds,
    listFunds,
    replaceMyAllocations,
} from "./fundService";

vi.mock("./api", () => ({
    default: { get: vi.fn(), put: vi.fn() },
}));

describe("fundService allocation response handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("unwraps the funds array returned by GET /api/funds", async () => {
        const rows = [{ fund_id: "fund-1", fund_name: "Growth" }];
        api.get.mockResolvedValue({ data: { status: "success", data: rows } });

        await expect(listFunds()).resolves.toEqual(rows);
        expect(api.get).toHaveBeenCalledWith("/api/funds");
    });

    it("loads worker-selectable funds from the dedicated available-funds endpoint", async () => {
        const rows = [{ fund_id: "fund-1", fund_name: "Growth", fund_status: "ACTIVE" }];
        api.get.mockResolvedValue({ data: { status: "success", data: rows } });

        await expect(listAvailableFunds()).resolves.toEqual(rows);
        expect(api.get).toHaveBeenCalledWith("/api/funds/available");
    });

    it("reads the authenticated worker's current allocations from the worker-scoped route", async () => {
        const rows = [{
            allocation_id: "allocation-1",
            fund_id: "fund-1",
            allocation_percentage: "100.00",
            effective_from: "2026-10-28",
            effective_to: null,
            fund_status: "ACTIVE",
        }];
        api.get.mockResolvedValue({ data: { status: "success", data: rows } });

        await expect(getMyAllocations()).resolves.toEqual(rows);
        expect(api.get).toHaveBeenCalledWith("/api/funds/my-allocations");
    });

    it("replaces the authenticated worker's complete allocation distribution", async () => {
        const allocations = [{ fund_id: "fund-1", allocation_percentage: "100.00" }];
        api.put.mockResolvedValue({ data: { status: "success", data: allocations } });

        await expect(replaceMyAllocations(allocations)).resolves.toEqual(allocations);
        expect(api.put).toHaveBeenCalledWith("/api/funds/my-allocations", { allocations });
    });

    it("unwraps dated allocation rows returned by GET /api/funds/:fundId/allocations", async () => {
        const rows = [{
            allocation_id: "allocation-1",
            account_id: "account-1",
            fund_id: "fund-1",
            percentage: "60.00",
            effective_from: "2026-10-01",
            effective_to: null,
        }];
        api.get.mockResolvedValue({ data: { status: "success", data: rows } });

        await expect(getFundAllocations("fund-1")).resolves.toEqual(rows);
        expect(api.get).toHaveBeenCalledWith("/api/funds/fund-1/allocations");
    });

    it("rejects unexpected response shapes instead of treating them as empty records", async () => {
        api.get.mockResolvedValue({ data: { status: "success", data: { allocations: [] } } });

        await expect(getFundAllocations("fund-1")).rejects.toThrow(
            "Unexpected response from GET /api/funds/:fundId/allocations: expected an array of records."
        );
    });

    it("surfaces the endpoint and HTTP status for API failures without exposing request credentials", async () => {
        const failure = { status: 403, message: "You do not manage this fund" };
        api.get.mockRejectedValue(failure);

        await expect(getFundAllocations("fund-1")).rejects.toThrow(
            "GET /api/funds/:fundId/allocations failed (HTTP 403): You do not manage this fund"
        );
    });
});
