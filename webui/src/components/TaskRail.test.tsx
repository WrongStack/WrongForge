/**
 * TaskRail rendering: the queue-wait chip a queued task must show (issue #7
 * visibility, fed by the store fold), the running marker, the cancel button,
 * and the active/ended filter — seeded through the public applyEvent path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { TaskRail } from "./TaskRail.js";
import { store } from "../lib/store.js";
import type { TaskEvent } from "../lib/types.js";

let seq = 0;
const ev = (task_id: string, type: TaskEvent["type"], data: Record<string, unknown> = {}): TaskEvent => ({
  seq: ++seq,
  ts: "2026-11-12T12:00:00.000Z",
  task_id,
  session_id: "ses_x",
  type,
  data,
});

const run = (task_id: string, prompt: string): TaskEvent[] => [
  ev(task_id, "task.queued", { position: 0, waiting_for: null }),
  ev(task_id, "task.started", { model: "claude-sonnet-5-5" }),
  ev(task_id, "agent.text", { text: prompt }),
];

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("TaskRail", () => {
  it("shows a queued task's position and wait reason as the queue chip", () => {
    store.applyEvent(ev("tq", "task.queued", { position: 1, waiting_for: "capacity" }));
    render(<TaskRail selectedId={null} onSelect={() => undefined} />);
    const chip = document.querySelector(".rail-report");
    expect(chip?.textContent).toContain("#2");
    expect(chip?.textContent).toContain("waiting: capacity");
  });

  it("shows the cancel button for queued and running tasks", () => {
    store.applyEvent(run("trun", "running prompt"));
    store.applyEvent(ev("tq2", "task.queued", { position: 0, waiting_for: "capacity" }));
    render(<TaskRail selectedId={null} onSelect={() => undefined} />);
    expect(screen.getAllByTitle("cancel this task").length).toBe(2);
  });

  it("the active filter keeps queued/running and hides ended tasks", () => {
    store.applyEvent(run("trun2", "running prompt"));
    store.applyEvent(ev("tend", "task.queued"));
    store.applyEvent(ev("tend", "task.started"));
    store.applyEvent(ev("tend", "task.completed", { result: {} }));
    render(<TaskRail selectedId={null} onSelect={() => undefined} />);
    fireEvent.click(screen.getByText("active"));
    expect(document.querySelectorAll(".rail-row").length).toBe(2);
    fireEvent.click(screen.getByText("ended"));
    expect(document.querySelectorAll(".rail-row").length).toBe(1);
  });

  it("the cancel button routes through store.cancelTask", async () => {
    store.applyEvent(ev("t-cancel-me", "task.queued", { position: 0, waiting_for: null }));
    // the singleton store accumulates tasks across this file's tests, so the
    // button must be scoped to the row (found via the task id the rail shows)
    const spy = vi.spyOn(store, "cancelTask").mockResolvedValue({ task: { id: "t-cancel-me" }, already_finished: false } as any);
    render(<TaskRail selectedId={null} onSelect={() => undefined} />);
    const row = screen.getByText("t-cancel-me").closest(".rail-row")!;
    fireEvent.click(row.querySelector('button[title="cancel this task"]')!);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith("t-cancel-me"));
  });
});
