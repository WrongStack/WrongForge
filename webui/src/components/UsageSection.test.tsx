/**
 * UsageSection component tests: fetch/render behavior of the usage history
 * section — days selector refetch, totals + by_day + by_client rendering,
 * error retry, and the empty-window state. The api module is mocked; the
 * fixture mirrors GET /v1/usage/summary's real response shape (F2202).
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UsageSection } from "./UsageSection.js";

const apiMock = vi.fn();
vi.mock("../lib/api.js", () => ({ api: (...a: unknown[]) => apiMock(...a) }));

const bucket = (over: Record<string, unknown> = {}) => ({
  tasks: 2, completed: 2, failed: 0, cancelled: 0, timed_out: 0,
  input_tokens: 1000, output_tokens: 200, cache_read_tokens: 800,
  cache_write_tokens: 100, fresh_input_tokens: 200, duration_ms: 65_000,
  ...over,
});

const fixture = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  days: 7,
  scope: { client: null, model: null },
  totals: bucket(),
  by_day: [{ date: "2026-11-12", ...bucket() }],
  by_client: { stackA: bucket(), stackB: bucket({ input_tokens: 500 }) },
  by_model: { "claude-sonnet-5-5": bucket() },
  ...over,
});

beforeEach(() => {
  apiMock.mockReset();
  cleanup();
});

describe("UsageSection", () => {
  it("fetches ?days=7 by default and renders totals + by_day rows", async () => {
    apiMock.mockResolvedValue(fixture());
    render(<UsageSection clientKey="k" />);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/v1/usage/summary?days=7", "k"));
    expect(await screen.findByText("usage history")).toBeTruthy();
    expect(screen.getByText("2026-11-12")).toBeTruthy();
    expect(screen.getAllByText("↑1.0k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("200").length).toBeGreaterThan(0); // fresh input appears in totals + day row
  });

  it("switching the days selector refetches with the new window", async () => {
    apiMock.mockResolvedValue(fixture());
    render(<UsageSection clientKey="k" />);
    await screen.findByText("usage history");
    fireEvent.click(screen.getByText("30d"));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/v1/usage/summary?days=30", "k"));
  });

  it("surfaces api errors with a retry button that refetches", async () => {
    apiMock.mockRejectedValueOnce(new Error("HTTP 502: usage_unavailable")).mockResolvedValue(fixture());
    render(<UsageSection clientKey="k" />);
    const err = await screen.findByText(/HTTP 502/);
    expect(err.textContent).toContain("retry");
    fireEvent.click(screen.getByText("retry"));
    await waitFor(() => expect(screen.queryByText(/HTTP 502/)).toBeNull());
    expect(apiMock).toHaveBeenCalledTimes(2);
  });

  it("empty by_day shows the no-finished-tasks row", async () => {
    apiMock.mockResolvedValue(fixture({ by_day: [], totals: bucket({ tasks: 0 }) }));
    render(<UsageSection clientKey="k" />);
    expect(await screen.findByText("no finished tasks in this window")).toBeTruthy();
  });

  it("renders the per-client table when more than one client exists", async () => {
    apiMock.mockResolvedValue(fixture());
    render(<UsageSection clientKey="k" />);
    await screen.findByText("usage history");
    expect(screen.getByText("stackA")).toBeTruthy();
    expect(screen.getByText("stackB")).toBeTruthy();
    expect(screen.getByText("↑500")).toBeTruthy();
  });

  it("hides the per-client table for a single-bucket (named-key) scope", async () => {
    apiMock.mockResolvedValue(fixture({ by_client: { stackA: bucket() }, scope: { client: "stackA", model: null } }));
    render(<UsageSection clientKey="stackA" />);
    await screen.findByText("usage history");
    expect(screen.queryByText("client")).toBeNull();
    const h2 = document.querySelector("h2.info-h");
    expect(h2?.textContent).toContain("stackA");
  });

  it("agent time renders compact units and an em-dash for zero", async () => {
    apiMock.mockResolvedValue(fixture({ totals: bucket({ duration_ms: 0 }), by_day: [{ date: "2026-11-12", ...bucket({ duration_ms: 0 }) }] }));
    render(<UsageSection clientKey="k" />);
    expect(await screen.findAllByText("—").then((r) => r.length > 0)).toBe(true);
    apiMock.mockResolvedValue(fixture({ totals: bucket({ duration_ms: 125_000 }) }));
    cleanup();
    render(<UsageSection clientKey="k" />);
    expect(await screen.findByText("2m")).toBeTruthy();
  });
});
