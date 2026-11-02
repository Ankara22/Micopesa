import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DataTable from "./DataTable";
import SkeletonLoader from "./SkeletonLoader";

const columns = [{ key: "name", header: "Name" }];

describe("shared loading primitives", () => {
    afterEach(cleanup);

    it("shows accessible table, profile, and dashboard skeletons", () => {
        const { rerender } = render(<SkeletonLoader variant="table" label="Loading user table" count={3} />);
        expect(screen.getByRole("status", { name: "Loading user table" })).toBeInTheDocument();

        rerender(<SkeletonLoader variant="profile" label="Loading profile" />);
        expect(screen.getByRole("status", { name: "Loading profile" })).toBeInTheDocument();

        rerender(<SkeletonLoader variant="dashboard" label="Loading dashboard" />);
        expect(screen.getByRole("status", { name: "Loading dashboard" })).toBeInTheDocument();

        rerender(<SkeletonLoader variant="articles" label="Loading articles" count={2} />);
        expect(screen.getByRole("status", { name: "Loading articles" })).toBeInTheDocument();

        rerender(<SkeletonLoader variant="form" label="Loading form" count={2} />);
        expect(screen.getByRole("status", { name: "Loading form" })).toBeInTheDocument();
    });

    it("shows initial loading and only shows an empty state after a successful empty response", () => {
        const { rerender } = render(
            <DataTable columns={columns} rows={[]} loading emptyMessage="No users yet." />
        );
        expect(screen.getByRole("status", { name: "Loading records" })).toBeInTheDocument();
        expect(screen.queryByText("No users yet.")).not.toBeInTheDocument();

        rerender(<DataTable columns={columns} rows={[]} loading={false} emptyMessage="No users yet." />);
        expect(screen.getByText("No users yet.")).toBeInTheDocument();
    });

    it("keeps previous rows visible during refresh and shows request errors with retry", () => {
        const retry = vi.fn();
        const { rerender } = render(
            <DataTable
                columns={columns}
                rows={[{ id: "user-1", name: "Amina" }]}
                refreshing
                error="Refresh failed"
                onRetry={retry}
            />
        );

        expect(screen.getByRole("status")).toHaveTextContent("Refreshing records");
        expect(screen.getByText("Amina")).toBeInTheDocument();
        expect(screen.getByRole("alert")).toHaveTextContent("Refresh failed");
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
        expect(retry).toHaveBeenCalledTimes(1);

        rerender(<DataTable columns={columns} rows={null} error="Initial load failed" onRetry={retry} />);
        expect(screen.getByRole("alert")).toHaveTextContent("Initial load failed");
    });
});
