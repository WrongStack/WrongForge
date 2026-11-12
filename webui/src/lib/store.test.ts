/**
 * The event-fold rules the dashboard lives on: queued/waiting state, live
 * status transitions, and the seq-guarded snapshot merge. Driven through the
 * public `applyEvent` / `getState` surface against a fresh store instance —
 * the same path a real SSE frame takes (minus the network).
 */

import { describe, expect, it } from "vitest";
import { Store } from "./store.js";
import type { TaskEvent } from "./types.js";

let seq = 0;
const ev = (task_id: string, type: TaskEvent["type"], data: Record<string, unknown> = {}): TaskEvent => ({
  seq: ++seq,
  ts: "2026-11-12T12:00:00.000Z",
  task_id,
  session_id: "ses_x",
  type,
  data,
});

const queued = (id: string, waiting = "capacity"): TaskEvent =>
  ev(id, "task.queued", { position: 0, waiting_for: waiting });

describe("store fold: queue_wait lifecycle", () => {
  it("creates a queued task with its queue_wait on task.queued (no prior doc)", () => {
    const s = new Store();
    s.applyEvent(queued("t1"));
    const t = s.getState().tasks.get("t1")!;
    expect(t.status).toBe("queued");
    expect(t.progress.queue_wait).toEqual({ position: 0, waiting_for: "capacity" });
  });

  it("updates position/waiting_for on task.queue_update", () => {
    const s = new Store();
    s.applyEvent(queued("t1"));
    s.applyEvent(ev("t1", "task.queue_update", { position: 2, waiting_for: "session" }));
    expect(s.getState().tasks.get("t1")!.progress.queue_wait).toEqual({ position: 2, waiting_for: "session" });
  });

  it("clears queue_wait when the task starts", () => {
    const s = new Store();
    s.applyEvent(queued("t1"));
    s.applyEvent(ev("t1", "task.started", { model: "claude-sonnet-5-5" }));
    const t = s.getState().tasks.get("t1")!;
    expect(t.status).toBe("running");
    expect(t.progress.queue_wait).toBeUndefined();
  });

  it("clears queue_wait on terminal events (a cancelled queued task stays cancelled, not waiting)", () => {
    const s = new Store();
    s.applyEvent(queued("t1"));
    s.applyEvent(ev("t1", "task.cancelled", { reason: "x" }));
    const t = s.getState().tasks.get("t1")!;
    expect(t.status).toBe("cancelled");
    expect(t.progress.queue_wait).toBeUndefined();
  });

  it("folds agent.report into last_report (retry visibility rides on this)", () => {
    const s = new Store();
    s.applyEvent(ev("t1", "task.started"));
    s.applyEvent(ev("t1", "agent.report", { message: "upstream 503 — retrying", phase: "retry" }));
    const t = s.getState().tasks.get("t1")!;
    expect(t.progress.last_report?.message).toBe("upstream 503 — retrying");
    expect(t.progress.last_report?.phase).toBe("retry");
  });

  it("applies the same rules to a task that already has a snapshot doc (patchTask path)", () => {
    const s = new Store();
    // seed a doc by sending queued first (the !doc branch), then drive patchTask
    s.applyEvent(queued("t1", null));
    s.applyEvent(ev("t1", "task.queue_update", { position: 3, waiting_for: null }));
    const t = s.getState().tasks.get("t1")!;
    expect(t.progress.queue_wait).toEqual({ position: 3, waiting_for: null });
  });
});
