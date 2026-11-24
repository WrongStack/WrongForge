/**
 * The right pane. No task selected → the system panel (model, queue, usage,
 * totals, per-tool stats — everything at a glance). A task selected → its full
 * run inline: meta, prompt, then each step with what went out (step.request),
 * what came back (finish + tokens) and every tool call with io.
 */

import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api.js";
import { store, useStore } from "../lib/store.js";
import type { TaskEvent, TaskRecord } from "../lib/types.js";
import { fmtTokens, shortId } from "../lib/types.js";
import { Bar, Chip, JsonPeek, StatusBadge, Tip } from "./bits.js";

export function Inspector({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  return (
    <aside className="inspector">
      {taskId ? <TaskPane taskId={taskId} onClose={onClose} /> : <SystemPane />}
    </aside>
  );
}

// ------------------------------------------------------------------ system

function SystemPane() {
  const info = useStore((s) => s.info);
  const usage = useStore((s) => s.usage);
  const totals = useStore((s) => s.totals);
  const tools = useStore((s) => s.tools);
  const sessions = useStore((s) => s.sessions);

  const toolRows = useMemo(
    () => [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 14),
    [tools],
  );

  return (
    <>
      <div className="insp-head">
        <span className="insp-title">system</span>
        <Tip text={`v${info?.version ?? "?"} · ${info?.signed_in ? "signed in" : "NOT signed in"} · cache ${info?.cache.default ?? "?"} · ${info?.mcp.servers ?? 0} MCP servers`}>
          <span className="ver">v{info?.version ?? "?"}</span>
        </Tip>
      </div>
      <div className="inspector-scroll">
        {info && (
          <div className="insp-grid">
            <Chip label="model" value={info.default_model} />
            <Chip label="effort" value={info.effort.default} tone="tone-cyan" />
            <Chip label="queue" value={`${info.queue.running}/${info.queue.max_concurrency} running · ${info.queue.queued} queued`} />
            <Chip label="sessions" value={String(sessions.length)} />
          </div>
        )}
        {usage && (
          <div className="insp-usage">
            <div className="insp-usage-row">
              <span>5h plan</span>
              <Bar percent={usage.five_hour.percent ?? 0} tone="tone-violet" />
              <span className="mono dim">{usage.five_hour.percent ?? 0}%</span>
            </div>
            {usage.weekly && (
              <div className="insp-usage-row">
                <span>weekly</span>
                <Bar percent={usage.weekly.percent ?? 0} tone="tone-cyan" />
                <span className="mono dim">{usage.weekly.percent ?? 0}%</span>
              </div>
            )}
          </div>
        )}
        <div className="insp-grid">
          <Chip label="model calls" value={String(totals.requests)} tone="tone-cyan" />
          <Chip label="tool calls" value={String(totals.toolCalls)} />
          <Chip label="tokens" value={`↑${fmtTokens(totals.in)} ↓${fmtTokens(totals.out)}`} tone="tone-violet" />
          <Chip label="cache read" value={fmtTokens(totals.cacheRead)} tone="tone-green" />
        </div>
        {toolRows.length > 0 && (
          <>
            <div className="insp-sub">tools</div>
            <table className="insp-tools mono">
              <tbody>
                {toolRows.map(([name, st]) => (
                  <tr key={name}>
                    <td className="tool-td-name">{name}</td>
                    <td>{st.calls} calls</td>
                    <td className={st.errors ? "tone-red-text" : "dim"}>{st.errors ? `${st.errors} err` : ""}</td>
                    <td>{st.running > 0 ? `↻ ${st.running}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className="insp-hint dim">select a task on the left to inspect its full run</div>
      </div>
    </>
  );
}

// -------------------------------------------------------------------- task

function TaskPane({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const tasks = useStore((s) => s.tasks);
  const perTask = useStore((s) => s.perTask);
  const doc = tasks.get(taskId);
  const events = perTask.get(taskId);
  const [fetchedDoc, setFetchedDoc] = useState<TaskRecord | null>(null);

  useEffect(() => {
    if (!taskId) {
      setFetchedDoc(null);
      return;
    }
    void store.backfillEvents(taskId);
    setFetchedDoc(null);
    void (async () => {
      try {
        const res = await api<{ task: TaskRecord }>(`/v1/tasks/${taskId}`, store.getState().key);
        setFetchedDoc(res.task);
      } catch {
        /* the live doc is usually enough */
      }
    })();
  }, [taskId]);

  const t = doc ?? fetchedDoc ?? undefined;
  const folded = useMemo(() => foldSteps(events ?? []), [events]);

  return (
    <>
      <div className="insp-head">
        <span className="insp-title mono">{taskId}</span>
        <button className="dialog-close" aria-label="close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="inspector-scroll">
        {t ? (
          <>
            <div className="task-meta">
              <StatusBadge status={t.status} />
              <Chip label="model" value={t.model} />
              <Chip label="effort" value={t.effort ?? "—"} tone="tone-cyan" />
              <Chip label="session" value={shortId(t.session_id, 14)} />
              <Chip label="steps" value={`${t.progress.steps}/${t.max_steps}`} />
              {t.status === "queued" && t.progress.queue_wait && (
                <Chip label="waiting" value={`#${t.progress.queue_wait.position + 1}${t.progress.queue_wait.waiting_for ? ` · ${t.progress.queue_wait.waiting_for}` : ""}`} tone="tone-amber" />
              )}
              {t.result && <Chip label="duration" value={`${Math.round(t.result.duration_ms / 1000)}s`} />}
              {t.result && (
                <Chip label="tokens" value={`↑${fmtTokens(t.result.usage.input_tokens)} ↓${fmtTokens(t.result.usage.output_tokens)}`} tone="tone-violet" />
              )}
              {(t.status === "running" || t.status === "queued") && (
                <button className="cancel-btn" onClick={() => void store.cancelTask(t.id)}>
                  ✕ cancel task
                </button>
              )}
            </div>
            <div className="insp-grid">
              <Chip label="workdir" value={t.workdir} />
              <Chip label="cache" value={t.cache ?? "—"} />
            </div>
            <div className="task-prompt mono">{t.prompt || <span className="dim">(no prompt captured)</span>}</div>
            {t.error && <div className="task-error">{t.error.code}: {t.error.message}</div>}
            <div className="task-steps">
              {folded.pre
                .filter((ev) => ev.type !== "task.started" && ev.type !== "task.queued")
                .map((ev) => (
                  <EventLine key={ev.seq} ev={ev} />
                ))}
              {folded.steps.map((s) => (
                <div key={s.step} className="step">
                  <div className="step-head">
                    <span className="step-no">step {s.step}</span>
                    {s.request && (
                      <span className="step-req mono">
                        → {String(s.request.data.model)} · effort {String(s.request.data.effort ?? "—")} ·{" "}
                        {String(s.request.data.messages)} msgs · {String(s.request.data.tools)} tools · max{" "}
                        {String(s.request.data.max_tokens)}
                      </span>
                    )}
                    {s.finished && (
                      <span className="step-fin mono">
                        ← {String(s.finished.data.finish_reason)} · in{" "}
                        {fmtTokens(Number((s.finished.data.usage as { input_tokens?: number })?.input_tokens ?? 0))} · out{" "}
                        {fmtTokens(Number((s.finished.data.usage as { output_tokens?: number })?.output_tokens ?? 0))} · ctx{" "}
                        {fmtTokens(Number(s.finished.data.context_tokens ?? 0))}
                      </span>
                    )}
                  </div>
                  {s.tools.map((tool, i) => (
                    <ToolCard key={`${tool.call.seq}-${i}`} tool={tool} />
                  ))}
                  {s.others.map((ev) => (
                    <EventLine key={ev.seq} ev={ev} />
                  ))}
                  {s.text && <pre className="step-text">{s.text}</pre>}
                </div>
              ))}
              {folded.post.map((ev) => (
                <EventLine key={ev.seq} ev={ev} />
              ))}
              {folded.steps.length === 0 && <div className="empty">no events for this task (yet)</div>}
            </div>
          </>
        ) : (
          <div className="empty">loading task…</div>
        )}
      </div>
    </>
  );
}

/** Folded view of one task's events: steps with their requests and results. */
interface StepBlock {
  step: number;
  request?: TaskEvent;
  started?: TaskEvent;
  finished?: TaskEvent;
  text: string;
  tools: Array<{ call: TaskEvent; result?: TaskEvent; error?: TaskEvent }>;
  others: TaskEvent[];
}

function foldSteps(events: TaskEvent[]): { pre: TaskEvent[]; steps: StepBlock[]; post: TaskEvent[] } {
  const pre: TaskEvent[] = [];
  const post: TaskEvent[] = [];
  const steps: StepBlock[] = [];
  let cur: StepBlock | null = null;
  const openTool = new Map<string, { call: TaskEvent; result?: TaskEvent; error?: TaskEvent }>();
  for (const ev of events) {
    if (ev.type === "task.heartbeat") continue;
    if (ev.type === "step.started" || ev.type === "step.request") {
      const n: number = Number(ev.data.step ?? 0) || (cur ? cur.step + 1 : 1);
      if (!cur || cur.step !== n) {
        cur = { step: n, text: "", tools: [], others: [] };
        steps.push(cur);
      }
      if (ev.type === "step.request") cur.request = ev;
      else cur.started = ev;
      continue;
    }
    if (!cur) {
      pre.push(ev);
      continue;
    }
    // after the last step finished, task-lifecycle events (completed/failed/
    // cancelled/timed_out) belong after the steps, not inside the last one
    if (cur.finished && ev.type.startsWith("task.")) {
      post.push(ev);
      continue;
    }
    switch (ev.type) {
      case "agent.text":
        cur.text += String(ev.data.text ?? "");
        break;
      case "tool.started": {
        const entry = { call: ev };
        cur.tools.push(entry);
        openTool.set(String(ev.data.tool_call_id ?? ""), entry);
        break;
      }
      case "tool.finished": {
        const entry = openTool.get(String(ev.data.tool_call_id ?? ""));
        // A result whose tool.started never reached this page (the dashboard
        // reconnected mid-call and the backfill resumed after it) carries the
        // name and the output itself: it stays a finished card of its own. As
        // a bare call it read as "running" forever and showed no output.
        if (entry) entry.result = ev;
        else cur.tools.push({ call: ev, result: ev });
        break;
      }
      case "tool.failed": {
        const entry = openTool.get(String(ev.data.tool_call_id ?? ""));
        if (entry) entry.error = ev;
        else cur.tools.push({ call: ev, error: ev });
        break;
      }
      case "step.finished":
        cur.finished = ev;
        break;
      default:
        cur.others.push(ev);
    }
  }
  return { pre, steps, post };
}

function ToolCard({ tool }: { tool: { call: TaskEvent; result?: TaskEvent; error?: TaskEvent } }) {
  const [open, setOpen] = useState(false);
  const name = String(tool.call.data.name ?? "?");
  const external = Boolean(tool.call.data.external);
  const state = tool.error ? "failed" : tool.result ? "done" : "running";
  return (
    <div className={`tool-card tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-state ts-${state}`}>{state === "running" ? "◌" : state === "failed" ? "✕" : "✓"}</span>
        <span className="tool-name mono">
          {name}
          {external && <span className="ext-badge">ext</span>}
        </span>
        <span className="tool-io mono">
          {open ? "hide io" : "show io"}
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-io-col">
            <div className="io-label">input</div>
            <JsonPeek value={tool.call.data.input} label="raw" max={0} />
          </div>
          <div className="tool-io-col">
            <div className="io-label">{tool.error ? "error" : "output"}</div>
            <JsonPeek value={tool.error ? tool.error.data.error : tool.result?.data.output} label="raw" max={0} />
          </div>
        </div>
      )}
    </div>
  );
}

function EventLine({ ev }: { ev: TaskEvent }) {
  return (
    <div className={`feed-row ${ev.type.startsWith("task.") ? "ev-task" : "ev-dim"}`}>
      <span className="feed-time">{ev.ts.slice(11, 23)}</span>
      <span className="feed-type">{ev.type}</span>
      <span className="feed-body">{JSON.stringify(ev.data).slice(0, 140)}</span>
    </div>
  );
}
