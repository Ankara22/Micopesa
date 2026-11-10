import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useApi from "../hooks/useApi";
import AuditLogsPanel from "./AuditLogsPanel";

vi.mock("../hooks/useApi", () => ({ default: vi.fn() }));

describe("AuditLogsPanel", () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it("renders redacted regulator event references and the empty state", () => {
        useApi.mockReturnValue({
            data: [{
                log_id: "log-1",
                full_name: "Authorized reviewer",
                user_role: "ADMIN",
                action_type: "APPROVE",
                entity_name: "KYC Review",
                entity_id: "VERIFIED",
                timestamp: "2026-11-10T10:00:00Z",
            }],
            loading: false,
            refreshing: false,
            error: null,
            refetch: vi.fn(),
        });

        const { rerender } = render(
            <AuditLogsPanel title="Operational Audit Logs" fetcher={vi.fn()} redacted />
        );
        const table = screen.getByRole("table");
        expect(within(table).getByText("Authorized reviewer")).toBeInTheDocument();
        expect(within(table).getByText("VERIFIED")).toBeInTheDocument();
        expect(within(table).getByRole("columnheader", { name: "Reference" })).toBeInTheDocument();
        expect(within(table).queryByRole("columnheader", { name: "Entity ID" })).not.toBeInTheDocument();

        useApi.mockReturnValue({
            data: [],
            loading: false,
            refreshing: false,
            error: null,
            refetch: vi.fn(),
        });
        rerender(<AuditLogsPanel title="Operational Audit Logs" fetcher={vi.fn()} redacted />);
        expect(screen.getByText("No audit log entries found.")).toBeInTheDocument();
    });

    it("shows a retryable error instead of an empty success state", () => {
        const refetch = vi.fn();
        useApi.mockReturnValue({
            data: null,
            loading: false,
            refreshing: false,
            error: "Audit log service unavailable",
            refetch,
        });

        render(<AuditLogsPanel title="Operational Audit Logs" fetcher={vi.fn()} redacted />);
        expect(screen.getByRole("alert")).toHaveTextContent("Audit log service unavailable");
        expect(screen.queryByText("No audit log entries found.")).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(refetch).toHaveBeenCalledOnce();
    });

    it("shows a loading state while the audit request is pending", () => {
        useApi.mockReturnValue({
            data: null,
            loading: true,
            refreshing: false,
            error: null,
            refetch: vi.fn(),
        });

        render(<AuditLogsPanel title="Operational Audit Logs" fetcher={vi.fn()} redacted />);
        expect(screen.getByRole("status", { name: "Loading records" })).toBeInTheDocument();
        expect(screen.queryByText("No audit log entries found.")).not.toBeInTheDocument();
    });
});
