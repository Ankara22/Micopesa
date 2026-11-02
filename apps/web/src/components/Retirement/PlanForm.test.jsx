import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PlanForm from "./PlanForm";

const toastMock = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
}));

vi.mock("../ui/ToastContext", () => ({
    useToast: () => toastMock,
}));

function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe("retirement plan form loading", () => {
    it("shows a pending state and ignores duplicate submissions until save finishes", async () => {
        const request = deferred();
        const onSaved = vi.fn(() => request.promise);
        const { container } = render(<PlanForm onSaved={onSaved} />);
        const form = container.querySelector("form");
        const submitButton = screen.getByRole("button", { name: "Calculate Projection" });

        fireEvent.submit(form);
        fireEvent.submit(form);

        expect(onSaved).toHaveBeenCalledTimes(1);
        expect(submitButton).toBeDisabled();
        expect(submitButton).toHaveAttribute("aria-busy", "true");

        request.resolve({ plan: { plan_id: "plan-1" } });
        await waitFor(() => expect(submitButton).toBeEnabled());
        expect(toastMock.success).toHaveBeenCalledWith(
            "Your retirement plan and projection have been updated."
        );
    });
});
