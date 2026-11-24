/**
 * Inspector fold (foldSteps) and task pane rendering, seeded through the
 * public applyEvent path: steps grouped with their request/finish lines, tool
 * call → result/failed pairing, agent.text concatenation, report/todos events
 * folded into their step, lifecycle events after the last step, and the
 * queued-task wait chip (issue #7 visibility). The api module is mocked — the
 * live document folded from events is what the pane shows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { Inspector } from "./Inspector.js";
import { store } from "../lib/store.js";
import type { TaskEvent } from "../lib/types.js";

const apiMock = vi.fn();
vi.mock("../lib/api.js", () => ({ api: (...a: unknown[]) => apiMock(...a) }));

let seq = 0;
const ev = (task_id: string, type: string, data: Record<string, unknown> = {}): TaskEvent => ({
  seq: ++seq,
  ts: "2026-11-24T12:00:00.000Z",
  task_id,
  session_id: "ses_x",
  type,
  data,
});
const seed = (events: TaskEvent[]): void => {
  for (const e of events) store.applyEvent(e);
};
/** The app root provides the tooltip provider the panes assume. */
const show = (taskId: string | null) =>
  render(
    <Tooltip.Provider>
      <Inspector taskId={taskId} onClose={() => undefined} />
    </Tooltip.Provider>,
  );

/** A completed two-step task: one tool that worked, one that failed. */
const twoSteps = (id: string): TaskEvent[] => [
  ev(id, "task.queued", { position: 0, waiting_for: null }),
  ev(id, "task.started", { model: "claude-sonnet-5-5" }),
  ev(id, "task.heartbeat"),
  ev(id, "step.started", { step: 1 }),
  ev(id, "step.request", { step: 1, model: "claude-sonnet-5-5", effort: "high", max_tokens: 32000, messages: 3, tools: 12 }),
  ev(id, "agent.text", { text: "Hel" }),
  ev(id, "agent.text", { text: "lo" }),
  ev(id, "tool.started", { tool_call_id: "toolu_ok", name: "bash", input: { cmd: "ls" } }),
  ev(id, "tool.finished", { tool_call_id: "toolu_ok", name: "bash", ok: true, output: { ok: true, text: "a b c" } }),
  ev(id, "agent.todos", { todos: [{ content: "ship it", status: "pending" }] }),
  ev(id, "agent.report", { message: "halfway", percent: 50 }),
  ev(id, "step.finished", { step: 1, finish_reason: "tool_use", usage: { input_tokens: 1200, output_tokens: 300 }, context_tokens: 2000 }),
  ev(id, "step.started", { step: 2 }),
  ev(id, "step.request", { step: 2, model: "claude-sonnet-5-5", effort: "high", max_tokens: 32000, messages: 5, tools: 12 }),
  ev(id, "tool.started", { tool_call_id: "toolu_bad", name: "read", input: { path: "missing.txt" } }),
  ev(id, "tool.failed", { tool_call_id: "toolu_bad", name: "read", error: "ENOENT" }),
  ev(id, "step.finished", { step: 2, finish_reason: "end_turn", usage: { input_tokens: 900, output_tokens: 120 }, context_tokens: 2100 }),
  ev(id, "task.completed", { result: { text: "done" } }),
];

const stepBlocks = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(".step")];

/** Opens a tool card and returns its io columns (input, then output/error). */
const openCard = (card: Element): HTMLElement[] => {
  fireEvent.click(card.querySelector(".tool-head")!);
  return [...card.querySelectorAll<HTMLElement>(".tool-io-col")];
};

/** Clicks a column's payload peek, returns what the dialog shows, closes it. */
const peek = (col: HTMLElement): string => {
  fireEvent.click(within(col).getByText("raw"));
  const dialog = document.querySelector<HTMLElement>(".dialog-json")!;
  const text = dialog.querySelector("pre")?.textContent ?? "";
  fireEvent.click(dialog.querySelector(".dialog-close")!); // only one dialog may be open for the next peek
  return text;
};

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  apiMock.mockReset();
  apiMock.mockRejectedValue(new Error("no snapshot")); // no network: the live document is enough
  vi.spyOn(store, "backfillEvents").mockResolvedValue(undefined);
});

describe("Inspector", () => {
  it("the system pane is shown when no task is selected", () => {
    show(null);
    expect(document.querySelector(".insp-title")?.textContent).toBe("system");
    expect(screen.getByText("select a task on the left to inspect its full run")).toBeTruthy();
  });

  it("groups events into steps, each with its request and finish line", () => {
    seed(twoSteps("t-steps"));
    show("t-steps");
    const steps = stepBlocks();
    expect(steps.length).toBe(2);
    expect(within(steps[0]!).getByText("step 1")).toBeTruthy();
    expect(within(steps[1]!).getByText("step 2")).toBeTruthy();
    expect(steps[0]!.querySelector(".step-req")?.textContent).toBe("→ claude-sonnet-5-5 · effort high · 3 msgs · 12 tools · max 32000");
    expect(steps[0]!.querySelector(".step-fin")?.textContent).toBe("← tool_use · in 1.2k · out 300 · ctx 2.0k");
    expect(steps[1]!.querySelector(".step-fin")?.textContent).toContain("← end_turn");
  });

  it("concatenates the agent.text deltas of a step", () => {
    seed(twoSteps("t-text"));
    show("t-text");
    expect(stepBlocks()[0]!.querySelector(".step-text")?.textContent).toBe("Hello");
  });

  it("pairs each tool call with its result or error", () => {
    seed(twoSteps("t-tools"));
    show("t-tools");
    const steps = stepBlocks();
    const done = steps[0]!.querySelector(".tool-card")!;
    const failed = steps[1]!.querySelector(".tool-card")!;
    expect(done.className).toContain("tool-done");
    expect(within(done as HTMLElement).getByText("bash")).toBeTruthy();
    expect(within(done as HTMLElement).getByText("✓")).toBeTruthy();
    expect(failed.className).toContain("tool-failed");
    expect(within(failed as HTMLElement).getByText("read")).toBeTruthy();
    expect(document.querySelector(".tool-running")).toBeNull();

    const [, output] = openCard(done);
    expect(output!.querySelector(".io-label")?.textContent).toBe("output");
    expect(peek(output!)).toContain("a b c");
    const [, error] = openCard(failed);
    expect(error!.querySelector(".io-label")?.textContent).toBe("error");
    expect(peek(error!)).toContain("ENOENT");
  });

  it("folds report and todos events into the step they belong to", () => {
    seed(twoSteps("t-others"));
    show("t-others");
    const first = stepBlocks()[0]!;
    expect(within(first).getByText("agent.todos")).toBeTruthy();
    expect(within(first).getByText("agent.report")).toBeTruthy();
    expect(first.querySelector(".feed-body")?.textContent).toContain("ship it");
  });

  it("puts lifecycle events after the steps and hides the prelude and heartbeats", () => {
    seed(twoSteps("t-post"));
    show("t-post");
    const last = stepBlocks().at(-1)!;
    const completed = screen.getByText("task.completed");
    expect(last.contains(completed)).toBe(false);
    expect(last.compareDocumentPosition(completed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("task.queued")).toBeNull();
    expect(screen.queryByText("task.started")).toBeNull();
    expect(screen.queryByText("task.heartbeat")).toBeNull();
  });

  it("shows a queued task's position and wait reason with a cancel button", () => {
    seed([ev("t-queued", "task.queued", { position: 1, waiting_for: "capacity" })]);
    show("t-queued");
    expect(screen.getByText("#2 · capacity")).toBeTruthy();
    expect(screen.getByText("✕ cancel task")).toBeTruthy();
    expect(screen.getByText("no events for this task (yet)")).toBeTruthy();
  });

  it("offers no cancel button once the task is finished", () => {
    seed(twoSteps("t-done"));
    show("t-done");
    expect(screen.queryByText("✕ cancel task")).toBeNull();
  });

  it("an open tool call shows as running", () => {
    seed([
      ev("t-running", "task.started"),
      ev("t-running", "step.started", { step: 1 }),
      ev("t-running", "tool.started", { tool_call_id: "toolu_slow", name: "bash", input: { cmd: "sleep 9" } }),
    ]);
    show("t-running");
    const card = document.querySelector(".tool-card")!;
    expect(card.className).toContain("tool-running");
    expect(within(card as HTMLElement).getByText("◌")).toBeTruthy();
  });

  // F3102: the dashboard reconnects mid-call and the backfill resumes after
  // tool.started — the result arrives alone. It carries name and output
  // itself, so it must read as finished, not as running forever with no io.
  it("a result that arrives without its tool call shows as done, with its output", () => {
    seed([
      ev("t-orphan-ok", "task.started"),
      ev("t-orphan-ok", "step.started", { step: 1 }),
      ev("t-orphan-ok", "tool.finished", { tool_call_id: "toolu_late", name: "read", ok: true, output: { text: "file body" } }),
    ]);
    show("t-orphan-ok");
    const card = document.querySelector(".tool-card")!;
    expect(card.className).toContain("tool-done");
    expect(card.className).not.toContain("tool-running");
    expect(within(card as HTMLElement).getByText("read")).toBeTruthy();
    const [, output] = openCard(card);
    expect(output!.querySelector(".io-label")?.textContent).toBe("output");
    expect(peek(output!)).toContain("file body");
  });

  it("a failure that arrives without its tool call shows as failed, with its error", () => {
    seed([
      ev("t-orphan-bad", "task.started"),
      ev("t-orphan-bad", "step.started", { step: 1 }),
      ev("t-orphan-bad", "tool.failed", { tool_call_id: "toolu_late", name: "bash", error: "exit 1" }),
    ]);
    show("t-orphan-bad");
    const card = document.querySelector(".tool-card")!;
    expect(card.className).toContain("tool-failed");
    expect(within(card as HTMLElement).getByText("bash")).toBeTruthy();
    const [, error] = openCard(card);
    expect(error!.querySelector(".io-label")?.textContent).toBe("error");
    expect(peek(error!)).toContain("exit 1");
  });
});
