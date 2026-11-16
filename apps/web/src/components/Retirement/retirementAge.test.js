import { describe, expect, it } from "vitest";
import { getProfileAge } from "./retirementAge";

describe("getProfileAge", () => {
    it("adjusts the age based on whether this year's birthday has passed", () => {
        const today = new Date("2026-06-15T12:00:00.000Z");

        expect(getProfileAge("1990-06-16", today)).toBe(35);
        expect(getProfileAge("1990-06-15", today)).toBe(36);
        expect(getProfileAge("1990-06-14", today)).toBe(36);
    });

    it("returns no age for missing, invalid, future, or unsupported dates", () => {
        const today = new Date("2026-06-15T12:00:00.000Z");

        expect(getProfileAge(null, today)).toBeNull();
        expect(getProfileAge("1990-02-30", today)).toBeNull();
        expect(getProfileAge("2026-06-16", today)).toBeNull();
        expect(getProfileAge("1925-06-15", today)).toBeNull();
    });
});
