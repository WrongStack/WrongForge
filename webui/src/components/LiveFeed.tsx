/**
 * The firehose: every task event as it happens, newest at the bottom,
 * filterable. Heartbeats are hidden by default (they would drown everything).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import * as ToggleGroup from "@radix-ui/react-toggle-group";
import * as Switch from "@radix-ui/react-switch";
import { store, useStore } from "../lib/store.js";
import { JsonPeek } from "./bits.js";
import { shortId } from "../lib/types.js";

const TYPE_TONE: Record<string, string> = {
  "http.request": "ev-http",
  "task.queued": "ev-task",
  "task.queue_update": "ev-task",
  "task.started": "ev-task",
  "task.completed": "ev-done",
  "task.failed": "ev-error",
  "task.cancelled": "ev-warn",
  "task.timed_out": "ev-warn",
  "task.heartbeat": "ev-dim",
  "step.started": "ev-step",
  "step.request": "ev-req",
  "step.finished": "ev-res",
  "agent.text": "ev-text",
  "agent.report": "ev-report",
  "agent.todos": "ev-report",
  "tool.started": "ev-tool",
  "tool.finished": "ev-tool-done",
  "tool.failed": "ev-error",
  "tools.loaded": "ev-tool",
  "context.cleared": "ev-warn",
  "session.compacting": "ev-dim",
  "session.compacted": "ev-dim",
  "session.cache_mode_locked": "ev-warn",
};

/** `task.queued` / `task.queue_update`: a 0-based position, and why the task is not running (null = it starts now). */
function queueSummary(data: Record<string, unknown>): string {
  return `#${Number(data.position ?? 0) + 1}${data.waiting_for ? ` · waiting: ${data.waiting_for}` : " · starting now"}${data.priority === "low" ? " · low priority" : ""}`;
}

/**
 * One line per event type (src/tasks/types.ts TaskEventType). The queue
 * position, a cancel reason, a tool-loading warning and a compaction result
 * used to flow past as a bare type label with an empty body — the operator
 * had to open the raw payload to learn why a task was cancelled or what the
 * gateway said (F3105).
 */
function summarize(type: string, data: Record<string, unknown>): string {
  const u = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
  const result = data.result as
    | { steps?: number; tool_calls?: number; text?: string; usage?: { input_tokens?: number; output_tokens?: number } }
    | undefined;
  const err = data.error as { code?: string; message?: string } | string | undefined;
  switch (type) {
    case "task.queued":
    case "task.queue_update":
      return queueSummary(data);
    case "task.started":
      return `model=${data.model} workdir=${data.workdir} effort=${data.effort ?? "?"}`;
    case "task.completed":
      return `steps=${result?.steps ?? "?"} tools=${result?.tool_calls ?? "?"} · ↑${result?.usage?.input_tokens ?? "?"} ↓${result?.usage?.output_tokens ?? "?"} · ${String(result?.text ?? "").slice(0, 70)}`;
    case "task.failed":
      return typeof err === "string"
        ? err.slice(0, 120)
        : `${err?.code ?? ""} ${err?.message ?? ""}`.trim().slice(0, 120);
    case "task.cancelled":
      return data.reason ? `cancelled — ${String(data.reason).slice(0, 100)}` : "cancelled";
    case "task.timed_out":
      return `timed out after ${Math.round(Number(data.timeout_ms ?? 0) / 1000)}s`;
    case "step.started":
      return `step ${String(data.step ?? "?")}`;
    case "step.request":
      return `→ model=${data.model} effort=${data.effort ?? "—"} msgs=${data.messages} tools=${data.tools} max=${data.max_tokens}`;
    case "step.finished":
      return `← ${data.finish_reason} in=${u?.input_tokens ?? "?"} out=${u?.output_tokens ?? "?"} ctx=${data.context_tokens}`;
    case "tools.loaded": {
      const warnings = Array.isArray(data.warnings) ? (data.warnings as unknown[]) : [];
      const parts = [`${String(data.count ?? 0)} tools · ${String(data.source ?? "?")}`];
      if (data.error) parts.push(`error: ${String(data.error).slice(0, 80)}`);
      if (warnings.length) {
        parts.push(`${warnings.length} warning${warnings.length === 1 ? "" : "s"}: ${String(warnings[0]).slice(0, 60)}${warnings.length > 1 ? " …" : ""}`);
      }
      return parts.join(" · ");
    }
    case "session.compacting":
      return `reason=${String(data.reason)} · ${String(data.messages)} msgs · ctx=${data.context_tokens ?? "?"}${data.threshold !== undefined ? ` (threshold ${String(data.threshold)})` : ""}`;
    case "session.compacted":
      return data.compacted
        ? `${String(data.turns_summarized)} turns summarized, ${String(data.turns_kept)} kept · ${String(data.messages_before)} → ${String(data.messages_after)} msgs`
        : String(data.note ?? "not compacted");
    case "session.cache_mode_locked":
      return `cache ${String(data.requested)} requested · session stays on ${String(data.locked)}`;
    case "context.cleared": {
      const n = Number(data.cleared ?? 0);
      return `${n} old tool result${n === 1 ? "" : "s"} cleared · ctx=${String(data.context_tokens)}`;
    }
    case "agent.todos": {
      const todos = Array.isArray(data.todos) ? (data.todos as { status?: unknown }[]) : [];
      const byStatus = new Map<string, number>();
      for (const todo of todos) byStatus.set(String(todo.status), (byStatus.get(String(todo.status)) ?? 0) + 1);
      return `${todos.length} todo${todos.length === 1 ? "" : "s"}${[...byStatus].map(([status, n]) => ` · ${n} ${status}`).join("")}`;
    }
    case "tool.started":
      return `${data.name}${data.external ? " (external)" : ""} ${JSON.stringify(data.input).slice(0, 90)}`;
    case "tool.finished":
      return `${data.name} ok=${String(data.ok ?? "?")}`;
    case "tool.failed":
      return `${data.name}: ${String(data.error).slice(0, 90)}`;
    case "agent.report":
      return `${data.phase ? `[${data.phase}] ` : ""}${data.message}${data.percent !== undefined ? ` (${data.percent}%)` : ""}`;
    case "agent.text":
      return String(data.text ?? "").slice(0, 120);
    case "task.heartbeat":
      return `elapsed=${Math.round(Number(data.elapsed_ms ?? 0) / 1000)}s`;
    default:
      return "";
  }
}

/** HTTP status → tone class (rows and the top-bar ticker share these). */
export function httpStatusClass(status: number): string {
  return status >= 500 ? "hstat-5xx" : status >= 400 ? "hstat-4xx" : status >= 200 && status < 300 ? "hstat-2xx" : "hstat-info";
}

/** One API call as its own shaped row: method · path · status · duration. */
function HttpRow({ data, ts }: { data: Record<string, unknown>; ts: string }) {
  const method = String(data.method ?? "?");
  const status = Number(data.status ?? 0);
  const dur = Number(data.duration_ms ?? 0);
  return (
    <>
      <span className="feed-time">{ts.slice(11, 23)}</span>
      <span className="feed-type">→ api</span>
      <span className={`feed-method m-${method.toLowerCase()}`}>{method}</span>
      <span className="feed-body feed-path">{String(data.path ?? "?")}</span>
      <span className={`feed-status ${httpStatusClass(status)}`}>{status}</span>
      <span className={`feed-dur${dur >= 1000 ? " dur-slow" : ""}`}>{dur}ms</span>
    </>
  );
}

export function LiveFeed({ onOpenTask }: { onOpenTask: (id: string) => void }) {
  const feed = useStore((s) => s.feed);
  const lastActivityAt = useStore((s) => s.lastActivityAt);
  const [filter, setFilter] = useState("all");
  const [showHeartbeats, setShowHeartbeats] = useState(false);
  const [follow, setFollow] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  const run = (what: "req" | "task"): void => {
    setBusy(what);
    void (what === "req" ? store.fireTestRequest() : store.submitDemoTask()).finally(() => setBusy(null));
  };

  /**
   * The "why is it quiet" strip: no task has ever run on this page and the
   * server has been silent for a minute — so every row above is the
   * dashboard's own refresh traffic. Says so, and offers the test actions.
   */
  const idleSec = lastActivityAt ? Math.round((now - lastActivityAt) / 1000) : null;
  const noRealWork = feed.every((r) => r.ev.task_id === "—");
  const showIdleStrip = idleSec !== null && idleSec > 60 && noRealWork;

  const rows = useMemo(
    () =>
      feed.filter((r) => {
        if (!showHeartbeats && r.ev.type === "task.heartbeat") return false;
        if (filter === "all") return true;
        if (filter === "http") return r.ev.type === "http.request";
        if (filter === "tasks") return r.ev.type.startsWith("task.");
        if (filter === "steps") return r.ev.type.startsWith("step.");
        if (filter === "tools") return r.ev.type.startsWith("tool");
        if (filter === "text") return r.ev.type.startsWith("agent.");
        return true;
      }),
    [feed, filter, showHeartbeats],
  );

  useEffect(() => {
    if (follow && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [rows.length, follow]);

  return (
    <div className="feed">
      <div className="feed-toolbar">
        <ToggleGroup.Root
          type="single"
          value={filter}
          onValueChange={(v) => v && setFilter(v)}
          className="seg"
          aria-label="filter events"
        >
          <ToggleGroup.Item value="all" className="seg-item">
            all
          </ToggleGroup.Item>
          <ToggleGroup.Item value="http" className="seg-item">
            http
          </ToggleGroup.Item>
          <ToggleGroup.Item value="tasks" className="seg-item">
            tasks
          </ToggleGroup.Item>
          <ToggleGroup.Item value="steps" className="seg-item">
            model steps
          </ToggleGroup.Item>
          <ToggleGroup.Item value="tools" className="seg-item">
            tools
          </ToggleGroup.Item>
          <ToggleGroup.Item value="text" className="seg-item">
            agent
          </ToggleGroup.Item>
        </ToggleGroup.Root>
        <label className="switch-row">
          <Switch.Root checked={showHeartbeats} onCheckedChange={setShowHeartbeats} className="switch">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          heartbeats
        </label>
        <label className="switch-row">
          <Switch.Root checked={follow} onCheckedChange={setFollow} className="switch">
            <Switch.Thumb className="switch-thumb" />
          </Switch.Root>
          follow
        </label>
        <button
          className="btn btn-ghost"
          onClick={() => run("req")}
          disabled={busy !== null}
          title="one harmless GET /v1/tools — watch it land as an http row"
        >
          ⚡ test request
        </button>
        <button
          className="btn"
          onClick={() => run("task")}
          disabled={busy !== null}
          title="submit a tiny real task (one ls, max 5 steps) — watch the full pipeline: Claude round-trips, tool calls, tokens"
        >
          ▶ run test task
        </button>
        <span className="feed-count">
          {rows.length}/{feed.length} events
        </span>
      </div>
      <div className="feed-scroll" ref={boxRef}>
        {showIdleStrip && (
          <div className="idle-strip">
            <span>
              quiet for {idleSec}s — no client has sent anything real to <span className="mono">{location.origin}</span>;
              the rows here are this dashboard's own refreshes. WrongStack isn't submitting.
            </span>
            <span className="idle-actions">
              <button className="btn btn-ghost" onClick={() => run("req")} disabled={busy !== null}>
                ⚡ test request
              </button>
              <button className="btn" onClick={() => run("task")} disabled={busy !== null}>
                ▶ run test task
              </button>
            </span>
          </div>
        )}
        {feed.length === 0 && (
          <div className="empty-panel">
            <div className="empty-title">nothing has reached this server yet</div>
            <p>
              This dashboard is a live window onto <span className="mono">this</span> WrongForge API: every HTTP request it
              receives, every task it runs — Claude round-trips, tool calls, gateway tools — flows here the moment it
              happens. An empty feed means exactly that: <b>no client has sent anything</b>.
            </p>
            <p>Make something happen right now:</p>
            <div className="empty-actions">
              <button className="btn btn-ghost" onClick={() => run("req")} disabled={busy !== null}>
                ⚡ test request (free, instant)
              </button>
              <button className="btn" onClick={() => run("task")} disabled={busy !== null}>
                ▶ run a test task (tiny, ~2 steps)
              </button>
            </div>
            <p className="dim">
              Real traffic comes from your orchestrator — check that WrongStack is running and pointed at{" "}
              <span className="mono">{location.origin}</span>.
            </p>
          </div>
        )}
        {feed.length > 0 && rows.length === 0 && <div className="empty">no events match this filter</div>}
        {rows.map((r) =>
          r.ev.type === "http.request" ? (
            <div key={r.key} className={`feed-row ev-http ${httpStatusClass(Number(r.ev.data.status ?? 0))}`}>
              <HttpRow data={r.ev.data} ts={r.ev.ts} />
            </div>
          ) : (
            <div key={r.key} className={`feed-row ${TYPE_TONE[r.ev.type] ?? ""}`}>
              <span className="feed-time">{r.ev.ts.slice(11, 23)}</span>
              <span className="feed-type">{r.ev.type}</span>
              <button className="feed-task" onClick={() => onOpenTask(r.ev.task_id)} title="open task detail">
                {shortId(r.ev.task_id, 14)}
              </button>
              <span className="feed-body">{summarize(r.ev.type, r.ev.data)}</span>
              <JsonPeek value={r.ev.data} label="{ }" max={0} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
