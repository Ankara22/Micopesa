import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useApi from "../../hooks/useApi";
import AuditLogs from "./AuditLogs";

vi.mock("../../hooks/useApi", () => ({ default: vi.fn() }));

describe("admin system audit logs", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("renders login, logout, and existing events and filters each action correctly", () => {
        useApi.mockReturnValue({
            data: [
                {
                    log_id: "login-1",
                    user_id: "user-1",
                    full_name: "Test Administrator",
                    user_role: "ADMIN",
                    action_type: "LOGIN",
                    entity_name: "AUTHENTICATION",
                    entity_id: "user-1",
                    timestamp: "2026-11-13T10:00:00.000Z",
                },
                {
                    log_id: "logout-1",
                    user_id: "user-1",
                    full_name: "Test Administrator",
                    user_role: "ADMIN",
                    action_type: "LOGOUT",
                    entity_name: "AUTHENTICATION",
                    entity_id: "user-1",
                    timestamp: "2026-11-13T11:00:00.000Z",
                },
                {
                    log_id: "update-1",
                    user_id: "user-2",
                    full_name: "Another Administrator",
                    user_role: "ADMIN",
                    action_type: "UPDATE",
                    entity_name: "USER",
                    entity_id: "user-2",
                    timestamp: "2026-11-13T09:00:00.000Z",
                },
            ],
            loading: false,
            refreshing: false,
            error: null,
            refetch: vi.fn(),
        });

        render(<AuditLogs />);
        const table = screen.getByRole("table");
        expect(within(table).getAllByRole("row")).toHaveLength(4);
        expect(within(table).getAllByText("Test Administrator")).toHaveLength(2);
        expect(within(table).getByText("Another Administrator")).toBeInTheDocument();
        expect(within(table).getByText("LOGIN")).toBeInTheDocument();
        expect(within(table).getByText("LOGOUT")).toBeInTheDocument();
        expect(within(table).getByText(new Date("2026-11-13T10:00:00.000Z").toLocaleString()))
            .toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "LOGIN" }));
        expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
        expect(within(screen.getByRole("table")).getByText("LOGIN")).toBeInTheDocument();
        expect(within(screen.getByRole("table")).queryByText("LOGOUT")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "LOGOUT" }));
        expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(2);
        expect(within(screen.getByRole("table")).getByText("LOGOUT")).toBeInTheDocument();
        expect(within(screen.getByRole("table")).queryByText("LOGIN")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "UPDATE" }));
        expect(within(screen.getByRole("table")).getByText("UPDATE")).toBeInTheDocument();
        expect(within(screen.getByRole("table")).queryByText("LOGIN")).not.toBeInTheDocument();
        expect(within(screen.getByRole("table")).queryByText("LOGOUT")).not.toBeInTheDocument();
    });
});
