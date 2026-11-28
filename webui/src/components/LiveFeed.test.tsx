/**
 * LiveFeed through the store's own SSE handler (storeHarness): the empty
 * state, http rows toned by status, the one-line summary of every task event
 * type, heartbeat and filter switches, row → task navigation, the "quiet"
 * strip, and the two test actions. The feed accumulates across a file's
 * tests, so the order-sensitive cases (empty, exact row counts, http-only
 * feed) run first.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LiveFeed } from "./LiveFeed.js";
import { api, connectStore, ev, fullInfo, httpFrame } from "../lib/storeHarness.js";
import { store } from "../lib/store.js";

vi.mock("../lib/api.js", async () => await import("../lib/storeHarness.js"));

const noop = (): void => undefined;
const show = (onOpenTask: (id: string) => void = noop) => render(<LiveFeed onOpenTask={onOpenTask} />);
const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".feed-scroll .feed-row")];
const taskRows = (): HTMLElement[] => rows().filter((r) => !r.classList.contains("ev-http"));
const rowTypes = (): string[] => taskRows().map((r) => r.querySelector(".feed-type")?.textContent ?? "");
const bodies = (taskId: string): (string | undefined)[] =>
  taskRows()
    .filter((r) => r.querySelector(".feed-task")?.textContent === taskId)
    .map((r) => r.querySelector(".feed-body")?.textContent);
const count = (): string | undefined => document.querySelector(".feed-count")?.textContent;

beforeEach(() => cleanup());
afterEach(() => {
  store.shutdown();
  vi.useRealTimers();
});

describe("LiveFeed", () => {
  it("explains an empty feed before anything has reached the server", () => {
    show();
    expect(screen.getByText("nothing has reached this server yet")).toBeTruthy();
    expect(count()).toBe("0/0 events");
  });

  it("shapes http frames as their own rows, toned by status and duration", async () => {
    const link = await connectStore();
    link.push(httpFrame("GET", "/v1/tasks?limit=300", 200, 12));
    link.push(httpFrame("POST", "/v1/tasks", 202, 30));
    link.push(httpFrame("GET", "/v1/nope", 404, 5));
    link.push(httpFrame("POST", "/v1/tasks", 500, 1500));
    show();

    expect(rows().length).toBe(4);
    expect(rows().map((r) => r.querySelector(".feed-method")?.textContent)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(rows().map((r) => r.querySelector(".feed-path")?.textContent)).toEqual(["/v1/tasks?limit=300", "/v1/tasks", "/v1/nope", "/v1/tasks"]);
    expect(rows().map((r) => r.querySelector(".feed-status")?.textContent)).toEqual(["200", "202", "404", "500"]);
    expect(rows().map((r) => [r.className, r.querySelector(".feed-status")!.className].every((c) => c.includes("hstat-2xx")))).toEqual([true, true, false, false]);
    expect(rows().map((r) => r.querySelector(".feed-status")?.className.replace("feed-status ", ""))).toEqual(["hstat-2xx", "hstat-2xx", "hstat-4xx", "hstat-5xx"]);
    expect(rows().map((r) => r.querySelector(".feed-dur")?.textContent)).toEqual(["12ms", "30ms", "5ms", "1500ms"]);
    expect(rows().filter((r) => r.querySelector(".dur-slow")).length).toBe(1);
    expect(count()).toBe("4/4 events");

    // only http frames so far: under "tasks" there is nothing to show
    fireEvent.click(screen.getByText("tasks"));
    expect(rows().length).toBe(0);
    expect(screen.getByText("no events match this filter")).toBeTruthy();
    fireEvent.click(screen.getByText("all"));
    expect(rows().length).toBe(4);
  });

  it("names the quiet state when only the dashboard's own refreshes are flowing", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const link = await connectStore();
    show();
    expect(screen.queryByText(/quiet for/)).toBeNull(); // fresh activity: no strip
    act(() => vi.advanceTimersByTime(61_000));
    expect(screen.getByText(/quiet for \d+s/)).toBeTruthy();
    expect(document.querySelector(".idle-strip")?.textContent).toContain("WrongStack isn't submitting");

    // a real client frame ends the quiet state at once
    act(() => link.push(ev("tsk_live", "task.started", { model: "m-one", workdir: "/work" }, new Date().toISOString())));
    act(() => vi.advanceTimersByTime(1_000));
    expect(document.querySelector(".idle-strip")).toBeNull();
    expect(screen.getByText("tsk_live")).toBeTruthy();
  });

  it("summarizes every task event type as one line", async () => {
    const link = await connectStore();
    const t = "tsk_flow";
    const push = (type: string, data: Record<string, unknown> = {}, taskId = t): void => link.push(ev(taskId, type, data));

    push("task.queued", { position: 0, waiting_for: null });
    push("task.started", { model: "m-one", workdir: "/work", effort: "high" });
    push("session.cache_mode_locked", { requested: "1h", locked: "5m" });
    push("tools.loaded", { source: "mcp", count: 3, tools: ["mcp_a_x", "mcp_a_y", "mcp_b_z"], warnings: [] });
    push("step.started", { step: 1 });
    push("step.request", { step: 1, model: "m-one", effort: "high", messages: 3, tools: 12, max_tokens: 32000 });
    push("agent.text", { text: "I will list the files" });
    push("agent.report", { message: "retrying upstream", percent: 50, phase: "retry" });
    push("agent.todos", { todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }, { content: "c", status: "pending" }] });
    push("tool.started", { tool_call_id: "toolu_1", name: "bash", input: { command: "ls" } });
    push("tool.finished", { tool_call_id: "toolu_1", name: "bash", ok: true, output: {} });
    push("tool.started", { tool_call_id: "toolu_2", name: "grep", external: true, input: { pattern: "todo" } });
    push("tool.failed", { tool_call_id: "toolu_2", name: "grep", error: "exit code 1" });
    push("context.cleared", { cleared: 4, context_tokens: 9000 });
    push("step.finished", { step: 1, finish_reason: "tool_use", usage: { input_tokens: 1200, output_tokens: 300 }, context_tokens: 9000 });
    push("session.compacting", { reason: "context_near_limit", context_tokens: 168000, threshold: 160000, messages: 41, keep_turns: 2 });
    push("session.compacted", { compacted: true, messages_before: 41, messages_after: 9, turns_summarized: 19, turns_kept: 2, summary_chars: 1200 });
    push("task.completed", { result: { steps: 1, tool_calls: 2, text: "done: a.ts b.ts", usage: { input_tokens: 1200, output_tokens: 300 } } });

    push("task.queued", { position: 2, waiting_for: "capacity" }, "tsk_waiting");
    push("task.queue_update", { position: 2, waiting_for: "capacity", priority: "low" }, "tsk_waiting");
    push("tools.loaded", { source: "inline", count: 5, tools: [], warnings: ['shadowed built-in "bash" (use the wstack_bash tool)', "second warning"] }, "tsk_waiting");
    push("session.compacting", { reason: "context_near_limit", context_tokens: null, threshold: 160000, messages: 3, keep_turns: 2 }, "tsk_waiting");
    push("session.compacted", { compacted: false, note: "nothing to summarize (2 or fewer turns)" }, "tsk_waiting");

    push("task.started", { model: "m-one", workdir: "/work" }, "tsk_cancelled");
    push("task.cancelled", { reason: "client disconnected" }, "tsk_cancelled");

    push("task.started", { model: "m-one", workdir: "/work" }, "tsk_timeout");
    push("task.timed_out", { timeout_ms: 30_000 }, "tsk_timeout");

    push("task.started", { model: "m-one", workdir: "/work" }, "tsk_failed");
    push("task.failed", { error: { code: "context_overflow", message: "prompt is too long" } }, "tsk_failed");

    // an optional gateway that could not be reached: the event says so itself
    push("tools.loaded", { source: "discovery", url: "https://gw.example", count: 0, tools: [], error: "gateway unreachable: ECONNREFUSED", warnings: [] }, "tsk_gw");

    show();

    expect(bodies("tsk_flow")).toEqual([
      "#1 · starting now",
      "model=m-one workdir=/work effort=high",
      "cache 1h requested · session stays on 5m",
      "3 tools · mcp",
      "step 1",
      "→ model=m-one effort=high msgs=3 tools=12 max=32000",
      "I will list the files",
      "[retry] retrying upstream (50%)",
      "3 todos · 2 completed · 1 pending",
      'bash {"command":"ls"}',
      "bash ok=true",
      'grep (external) {"pattern":"todo"}',
      "grep: exit code 1",
      "4 old tool results cleared · ctx=9000",
      "← tool_use in=1200 out=300 ctx=9000",
      "reason=context_near_limit · 41 msgs · ctx=168000 (threshold 160000)",
      "19 turns summarized, 2 kept · 41 → 9 msgs",
      "steps=1 tools=2 · ↑1200 ↓300 · done: a.ts b.ts",
    ]);
    expect(bodies("tsk_waiting")).toEqual([
      "#3 · waiting: capacity",
      "#3 · waiting: capacity · low priority",
      '5 tools · inline · 2 warnings: shadowed built-in "bash" (use the wstack_bash tool) …',
      "reason=context_near_limit · 3 msgs · ctx=? (threshold 160000)",
      "nothing to summarize (2 or fewer turns)",
    ]);
    expect(bodies("tsk_cancelled")).toEqual(["model=m-one workdir=/work effort=?", "cancelled — client disconnected"]);
    expect(bodies("tsk_timeout")).toEqual(["model=m-one workdir=/work effort=?", "timed out after 30s"]);
    expect(bodies("tsk_failed")).toEqual(["model=m-one workdir=/work effort=?", "context_overflow prompt is too long"]);
    expect(bodies("tsk_gw")).toEqual(["0 tools · discovery · error: gateway unreachable: ECONNREFUSED"]);

    // tones: lifecycle, errors, external work
    const toneOf = (type: string, taskId: string): string => {
      const row = taskRows().find((r) => r.querySelector(".feed-task")?.textContent === taskId && r.querySelector(".feed-type")?.textContent === type);
      return row?.className ?? "";
    };
    expect(toneOf("task.completed", t)).toContain("ev-done");
    expect(toneOf("task.failed", "tsk_failed")).toContain("ev-error");
    expect(toneOf("task.cancelled", "tsk_cancelled")).toContain("ev-warn");
    expect(toneOf("task.queue_update", "tsk_waiting")).toContain("ev-task");
    expect(toneOf("session.cache_mode_locked", t)).toContain("ev-warn");
    expect(toneOf("tool.started", t)).toContain("ev-tool");

    // every task row carries the raw payload one click away
    expect(taskRows().every((r) => r.querySelector(".json-peek")?.textContent === "{ }")).toBe(true);
  });

  it("hides heartbeats until asked", async () => {
    const link = await connectStore();
    link.push(ev("tsk_beat", "task.started", { model: "m-one", workdir: "/work" }));
    link.push(ev("tsk_beat", "task.heartbeat", { elapsed_ms: 4500, steps: 1 }));
    show();
    expect(screen.queryByText("task.heartbeat")).toBeNull();
    expect(count()).toBe(`${store.getState().feed.length - 1}/${store.getState().feed.length} events`);

    fireEvent.click(screen.getByRole("switch", { name: "heartbeats" }));
    const beat = screen.getByText("task.heartbeat").closest(".feed-row")!;
    expect(beat.querySelector(".feed-body")?.textContent).toBe("elapsed=5s");
    expect(beat.className).toContain("ev-dim");
    expect(count()).toBe(`${store.getState().feed.length}/${store.getState().feed.length} events`);
  });

  it("filters the feed by kind", async () => {
    const link = await connectStore();
    link.push(ev("tsk_filter", "context.cleared", { cleared: 1, context_tokens: 10 }));
    link.push(ev("tsk_filter", "tools.loaded", { source: "builtin", count: 4, tools: [], warnings: [] }));

    show();
    const all = rowTypes().length;
    expect(all).toBeGreaterThan(2);

    fireEvent.click(screen.getByText("tools"));
    expect(rowTypes().length).toBeGreaterThan(0);
    expect(rowTypes().every((type) => type!.startsWith("tool"))).toBe(true);
    expect(rowTypes()).toContain("tools.loaded");

    fireEvent.click(screen.getByText("agent"));
    expect(rowTypes().every((type) => type!.startsWith("agent."))).toBe(true);

    fireEvent.click(screen.getByText("tasks"));
    expect(rowTypes().length).toBeGreaterThan(0);
    expect(rowTypes().every((type) => type!.startsWith("task."))).toBe(true);

    fireEvent.click(screen.getByText("model steps"));
    expect(rowTypes().length).toBeGreaterThan(0);
    expect(rowTypes().every((type) => type!.startsWith("step."))).toBe(true);

    fireEvent.click(screen.getByText("http"));
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().every((r) => r.classList.contains("ev-http"))).toBe(true);

    fireEvent.click(screen.getByText("all"));
    expect(rowTypes().length).toBe(all);
  });

  it("opens the task behind a row", async () => {
    const link = await connectStore();
    link.push(ev("tsk_open_me", "task.started", { model: "m-one", workdir: "/work" }));
    const opened = vi.fn();
    show(opened);
    fireEvent.click(screen.getByText("tsk_open_me").closest(".feed-task")!);
    expect(opened).toHaveBeenCalledWith("tsk_open_me");
  });

  it("runs the two test actions, and blocks both buttons while one is in flight", async () => {
    let release!: (body: unknown) => void;
    const link = await connectStore({ info: fullInfo, routes: new Map([["/v1/tools", () => new Promise((resolve) => (release = resolve))]]) });
    show();
    const test = screen.getByText<HTMLButtonElement>("⚡ test request");
    const demo = screen.getByText<HTMLButtonElement>("▶ run test task");

    fireEvent.click(test);
    expect(test.disabled).toBe(true);
    expect(demo.disabled).toBe(true);
    await act(async () => {
      release({ tools: [] });
    });
    await waitFor(() => expect(demo.disabled).toBe(false));

    fireEvent.click(demo);
    await waitFor(() => expect(api.mock.calls.some((call) => call[0] === "/v1/tasks")).toBe(true));
    const init = api.mock.calls.find((call) => call[0] === "/v1/tasks")![2]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ workdir: "/work", max_steps: 5 });
    await waitFor(() => expect(demo.disabled).toBe(false));
  });
});
