/**
 * InsightsView against real task documents — the snapshot path the dashboard
 * uses (store.connect → refresh), plus the live-event-only path. Covers the
 * per-model table (tokens, steps, average run), the outcome strip, totals, the
 * tools table and the empty state.
 *
 * F3103 regression: the helpers this view relies on (ModelRow, STATUS_COLORS,
 * avgDuration) were dropped when UsageSection was split out of the file, and
 * the pane threw ReferenceError as soon as any task existed. Nothing rendered
 * it WITH tasks, so no test noticed (v0.4.25 / v0.4.26 shipped it).
 *
 * The store is a singleton that keeps its snapshot and tool counters across
 * tests, so the order matters: the empty state first, then a task known only
 * from events, then a snapshot that replaces the task list.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { InsightsView } from "./InsightsView.js";
import { store } from "../lib/store.js";
import type { TaskEvent, TaskRecord } from "../lib/types.js";

const apiMock = vi.fn();
vi.mock("../lib/api.js", () => ({
  api: (...a: unknown[]) => apiMock(...a),
  connectEvents: () => () => undefined, // no live feed in these tests
  saveKey: () => undefined,
}));

const at = "2026-11-24T12:00:00.000Z";
const usage = (input_tokens: number, output_tokens: number) => ({
  input_tokens,
  output_tokens,
  total_tokens: input_tokens + output_tokens,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
});

/** A task document as GET /v1/tasks returns it; `run` marks one that finished. */
function doc(id: string, status: TaskRecord["status"], model: string, run?: { duration_ms: number; input: number; output: number }): TaskRecord {
  return {
    id,
    status,
    session_id: "ses_x",
    session_created: false,
    prompt: `prompt ${id}`,
    model,
    max_steps: 50,
    timeout_ms: 60_000,
    workdir: "/work",
    workdir_lock: false,
    created_at: at,
    progress: { last_event_seq: 1, steps: run ? 3 : 0, tool_calls: run ? 5 : 0, last_activity_at: at },
    ...(run
      ? {
          result: {
            text: "ok",
            finish_reason: "end_turn",
            steps: 3,
            tool_calls: 5,
            usage: usage(run.input, run.output),
            context_tokens: 2000,
            context_window: 200_000,
            context_percent: 1,
            duration_ms: run.duration_ms,
          },
        }
      : {}),
  };
}

const emptyBucket = () => ({
  tasks: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, fresh_input_tokens: 0, duration_ms: 0,
});

/** Connects the store against a fake server whose task list is `tasks`. */
async function connectWith(tasks: TaskRecord[]): Promise<void> {
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/v1/info") return { name: "WrongForge", version: "test" };
    if (path.startsWith("/v1/tasks?limit=300")) return { tasks };
    if (path === "/v1/sessions") return { sessions: [] };
    if (path === "/v1/usage") {
      return { five_hour: { percent: 10, resetsAt: null, isActive: true }, weekly: null, extra_usage: { enabled: false, usedCredits: null, monthlyLimit: null, utilization: null } };
    }
    if (path.startsWith("/v1/usage/summary?days=")) return { days: 7, scope: { client: null, model: null }, totals: emptyBucket(), by_day: [], by_client: {}, by_model: {} };
    if (/\/events\?limit=2000$/.test(path)) return { events: [] };
    throw new Error(`unexpected api call: ${path}`);
  });
  await store.connect("test-key");
}

/** The `<section>` that owns the given `<h2>` heading. */
const section = (heading: string): HTMLElement => screen.getByRole("heading", { level: 2, name: heading }).closest("section") as HTMLElement;
const cells = (row: Element): string[] => [...(row as HTMLTableRowElement).cells].map((c) => c.textContent ?? "");
const rowOf = (scope: HTMLElement, text: string): string[] => cells(within(scope).getByText(text).closest("tr")!);

beforeEach(() => {
  cleanup();
  apiMock.mockReset();
});
afterEach(() => {
  store.shutdown(); // drops the usage timer connect() started
});

describe("InsightsView", () => {
  it("stays whole with no tasks, models or tool calls", async () => {
    await connectWith([]);
    render(<InsightsView />);
    expect(within(section("models")).getByText("no tasks yet — run one from the Overview tab to see per-model stats here")).toBeTruthy();
    expect(within(section("task outcomes")).getByText("—")).toBeTruthy();
    expect(within(section("tools")).getByText("no tool calls observed yet (live since this page connected)")).toBeTruthy();
    expect(within(section("totals")).getByText("tasks").closest(".chip")!.querySelector(".chip-value")?.textContent).toBe("0");
  });

  it("aggregates a task known only from live events", () => {
    let seq = 0;
    const ev = (type: TaskEvent["type"], data: Record<string, unknown> = {}): TaskEvent => ({ seq: ++seq, ts: at, task_id: "t-live", session_id: "ses_x", type, data });
    store.applyEvent(ev("task.started", { model: "m-live" }));
    store.applyEvent(ev("step.started", { step: 2 }));
    store.applyEvent(ev("tool.started", { tool_call_id: "toolu_1", name: "bash", input: {} }));
    render(<InsightsView />);
    // no snapshot → no result: counts come from progress, the average run is unknown
    //          model      tasks  ok / fail  tokens      steps  tools  avg run
    expect(rowOf(section("models"), "m-live")).toEqual(["m-live", "1", "0 / 0", "↑0 ↓0", "2", "1", "—"]);
    expect(within(section("task outcomes")).getByTitle("running: 1")).toBeTruthy();
    //                       tool     calls  bar  running  errors
    expect(rowOf(section("tools"), "bash")).toEqual(["bash", "1", "", "↻ 1", ""]);
  });

  it("aggregates tasks per model with tokens, steps and the average run", async () => {
    await connectWith([
      doc("t-a1", "completed", "m-alpha", { duration_ms: 30_000, input: 1200, output: 300 }),
      doc("t-a2", "completed", "m-alpha", { duration_ms: 50_000, input: 800, output: 200 }),
      doc("t-b1", "failed", "m-beta", { duration_ms: 20_000, input: 100, output: 10 }),
      doc("t-b2", "queued", "m-beta"),
    ]);
    render(<InsightsView />);
    const models = section("models");
    //          model       tasks  ok / fail  tokens       steps  tools  avg run
    expect(rowOf(models, "m-alpha")).toEqual(["m-alpha", "2", "2 / 0", "↑2.0k ↓500", "6", "10", "40s"]);
    expect(rowOf(models, "m-beta")).toEqual(["m-beta", "2", "0 / 1", "↑100 ↓10", "3", "5", "20s"]);

    const outcomes = section("task outcomes");
    // strip segments carry their count as the label (ratio > 8%), the pills as "● <status> <n>"
    expect([...outcomes.querySelectorAll(".outcome-seg")].map((seg) => [seg.getAttribute("title"), seg.textContent])).toEqual([
      ["completed: 2", "completed 2"],
      ["failed: 1", "failed 1"],
      ["queued: 1", "queued 1"],
    ]);
    expect([...outcomes.querySelectorAll(".effort-pill")].map((p) => p.textContent)).toEqual(["● completed 2", "● failed 1", "● queued 1"]);

    expect(within(section("totals")).getByText("tasks").closest(".chip")!.querySelector(".chip-value")?.textContent).toBe("4");
  });
});
