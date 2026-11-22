import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Modal from "./Modal";

describe("shared modal", () => {
    afterEach(() => {
        cleanup();
        document.body.style.overflow = "";
    });

    it("labels the dialog and keeps optional actions in a separate footer", () => {
        render(
            <Modal
                open
                title="Edit account"
                footer={<button type="button">Save</button>}
            >
                <label htmlFor="account-name">Account name</label>
                <input id="account-name" />
            </Modal>
        );

        const dialog = screen.getByRole("dialog", { name: "Edit account" });
        expect(dialog).toHaveClass("modal--standard");
        expect(dialog.querySelector(".modal-header")).toHaveTextContent("Edit account");
        expect(dialog.querySelector(".modal-body")).toContainElement(screen.getByLabelText("Account name"));
        expect(dialog.querySelector(".modal-footer")).toContainElement(screen.getByRole("button", { name: "Save" }));
    });

    it.each(["wide", "review"])("applies the %s responsive size variant", (size) => {
        render(<Modal open size={size} title="Long record">Content</Modal>);
        expect(screen.getByRole("dialog", { name: "Long record" })).toHaveClass(`modal--${size}`);
    });

    it("keeps long records in the scrollable body and leaves the footer separate", () => {
        const history = Array.from({ length: 40 }, (_, index) => (
            <p key={index}>Historical submission {index + 1}</p>
        ));
        render(
            <Modal open size="review" title="Compliance report history" footer={<button>Close history</button>}>
                {history}
            </Modal>
        );

        const dialog = screen.getByRole("dialog", { name: "Compliance report history" });
        const body = dialog.querySelector(".modal-body");
        expect(body).toContainElement(screen.getByText("Historical submission 40"));
        expect(dialog.querySelector(".modal-footer")).toContainElement(
            screen.getByRole("button", { name: "Close history" })
        );
    });

    it("locks background scrolling, closes on Escape, and restores focus and scrolling", () => {
        function Harness() {
            const [open, setOpen] = useState(false);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
                    <Modal open={open} title="Details" onClose={() => setOpen(false)}>Record details</Modal>
                </>
            );
        }

        render(<Harness />);
        const opener = screen.getByRole("button", { name: "Open dialog" });
        opener.focus();
        fireEvent.click(opener);
        const dialog = screen.getByRole("dialog", { name: "Details" });
        expect(document.body.style.overflow).toBe("hidden");
        expect(dialog).toHaveFocus();

        fireEvent.keyDown(window, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Details" })).not.toBeInTheDocument();
        expect(document.body.style.overflow).toBe("");
        expect(opener).toHaveFocus();
    });

    it("keeps keyboard focus within the dialog", () => {
        render(
            <Modal open title="Details" footer={<button type="button">Save</button>}>
                <button type="button">First action</button>
            </Modal>
        );

        const close = screen.getByRole("button", { name: "Close" });
        const save = screen.getByRole("button", { name: "Save" });
        save.focus();
        fireEvent.keyDown(window, { key: "Tab" });
        expect(close).toHaveFocus();
        fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
        expect(save).toHaveFocus();
    });

    it("preserves backdrop closing behavior", () => {
        const onClose = vi.fn();
        const { container } = render(<Modal open title="Details" onClose={onClose}>Record details</Modal>);

        fireEvent.mouseDown(container.querySelector(".modal-overlay"));
        expect(onClose).toHaveBeenCalledOnce();
    });
});
