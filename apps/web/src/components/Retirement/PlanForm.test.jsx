import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import PlanForm from "./PlanForm";

afterEach(cleanup);

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
    it("uses and locks an asynchronously loaded profile age", async () => {
        const onSaved = vi.fn().mockResolvedValue({ plan: { plan_id: "plan-1" } });
        const { container, rerender } = render(<PlanForm onSaved={onSaved} />);
        const age = screen.getByLabelText("Your current age");

        expect(age).toHaveValue(null);
        expect(age).toHaveAttribute("readonly");

        rerender(<PlanForm profileAge={36} onSaved={onSaved} />);
        expect(age).toHaveValue(36);
        expect(age).toHaveAttribute("readonly");
        fireEvent.change(screen.getByLabelText("Target retirement age"), { target: { value: "65" } });
        fireEvent.change(screen.getByLabelText("Retirement savings goal (KSh)"), { target: { value: "100000.00" } });
        fireEvent.change(screen.getByLabelText("Planned monthly contribution (KSh)"), { target: { value: "1000.00" } });

        fireEvent.submit(container.querySelector("form"));
        await waitFor(() => {
            expect(onSaved).toHaveBeenCalledTimes(1);
        });
        expect(onSaved.mock.calls[0][0]).not.toHaveProperty("current_age");
    });

    it("shows a pending state and ignores duplicate submissions until save finishes", async () => {
        const request = deferred();
        const onSaved = vi.fn(() => request.promise);
        const { container } = render(<PlanForm onSaved={onSaved} />);
        const form = container.querySelector("form");
        const submitButton = screen.getByRole("button", { name: "Calculate Projection" });
        fireEvent.change(screen.getByLabelText("Retirement savings goal (KSh)"), { target: { value: "100000" } });
        fireEvent.change(screen.getByLabelText("Planned monthly contribution (KSh)"), { target: { value: "1000" } });

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

    it("rejects exponent-form amounts before saving a plan", () => {
        const onSaved = vi.fn();
        const { container } = render(<PlanForm onSaved={onSaved} />);
        fireEvent.change(screen.getByLabelText("Retirement savings goal (KSh)"), { target: { value: "1e3" } });
        fireEvent.change(screen.getByLabelText("Planned monthly contribution (KSh)"), { target: { value: "0" } });
        fireEvent.submit(container.querySelector("form"));

        expect(toastMock.error).toHaveBeenCalledWith(
            "Enter KES amounts using no more than two decimal places and within the supported limit.",
        );
        expect(onSaved).not.toHaveBeenCalled();
    });
});
