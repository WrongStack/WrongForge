/**
 * The analytics pane: what the store already knows, aggregated — per-model
 * usage and outcomes, task status mix, per-tool activity, and the live
 * session totals. The "usage history" section is the one exception: it
 * fetches GET /v1/usage/summary for server-side history beyond this page's
 * live window (and the per-client breakdown a named-key page cannot see).
 */

import { useMemo } from "react";
import { useStore } from "../lib/store.js";
import { Bar, Chip } from "./bits.js";
import { UsageSection } from "./UsageSection.js";
import { fmtTokens } from "../lib/types.js";

interface ModelRow {
  model: string;
  tasks: number;
  completed: number;
  failed: number;
  in: number;
  out: number;
  steps: number;
  toolCalls: number;
  durations: number[];
}

const STATUS_COLORS: Record<string, string> = {
  completed: "var(--blue)",
  running: "var(--green)",
  queued: "var(--amber)",
  failed: "var(--red)",
  cancelled: "var(--fg-faint)",
  timed_out: "var(--orange)",
};

function avgDuration(list: number[]): string {
  const done = list.filter((d) => d > 0);
  if (!done.length) return "—";
  const a = done.reduce((s, d) => s + d, 0) / done.length / 1000;
  return a >= 60 ? `${Math.round(a / 60)}m` : `${a.toFixed(a < 10 ? 1 : 0)}s`;
}

export function InsightsView() {
  const key = useStore((s) => s.key);
  const tasks = useStore((s) => s.tasks);
  const tools = useStore((s) => s.tools);
  const totals = useStore((s) => s.totals);
  const sessions = useStore((s) => s.sessions);

  const models = useMemo(() => {
    const byModel = new Map<string, ModelRow>();
    for (const t of tasks.values()) {
      const m = t.model || "—";
      const row =
        byModel.get(m) ??
        ({ model: m, tasks: 0, completed: 0, failed: 0, in: 0, out: 0, steps: 0, toolCalls: 0, durations: [] } as ModelRow);
      row.tasks++;
      if (t.status === "completed") row.completed++;
      if (t.status === "failed" || t.status === "timed_out") row.failed++;
      row.steps += t.progress?.steps ?? 0;
      row.toolCalls += t.progress?.tool_calls ?? 0;
      if (t.result?.usage) {
        row.in += t.result.usage.input_tokens ?? 0;
        row.out += t.result.usage.output_tokens ?? 0;
      }
      if (t.result?.duration_ms) row.durations.push(t.result.duration_ms);
      byModel.set(m, row);
    }
    return [...byModel.values()].sort((a, b) => b.tasks - a.tasks);
  }, [tasks]);

  const statuses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tasks.values()) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [tasks]);
  const totalTasks = statuses.reduce((s, [, n]) => s + n, 0) || 1;

  const toolRows = useMemo(() => [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls).slice(0, 20), [tools]);
  const maxToolCalls = toolRows[0]?.[1].calls ?? 1;

  return (
    <div className="info-page">
      <UsageSection clientKey={key} />
      <section className="info-sec">
        <h2 className="info-h">totals</h2>
        <div className="insp-grid">
          <Chip label="tasks" value={String(tasks.size)} />
          <Chip label="sessions" value={String(sessions.length)} />
          <Chip label="model calls" value={String(totals.requests)} tone="tone-cyan" />
          <Chip label="tool calls" value={String(totals.toolCalls)} />
          <Chip label="tokens" value={`↑${fmtTokens(totals.in)} ↓${fmtTokens(totals.out)}`} tone="tone-violet" />
          <Chip label="cache read" value={fmtTokens(totals.cacheRead)} tone="tone-green" />
        </div>
      </section>

      <section className="info-sec">
        <h2 className="info-h">models</h2>
        {models.length ? (
          <table className="info-table">
            <thead>
              <tr>
                <th>model</th>
                <th>tasks</th>
                <th>ok / fail</th>
                <th>tokens ↑↓</th>
                <th>steps</th>
                <th>tools</th>
                <th>avg run</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model}>
                  <td className="mono">{m.model}</td>
                  <td className="mono">{m.tasks}</td>
                  <td className="mono">
                    <span className="ok-count">{m.completed}</span>
                    {" / "}
                    <span className={m.failed ? "fail-count" : "dim"}>{m.failed}</span>
                  </td>
                  <td className="mono">
                    ↑{fmtTokens(m.in)} ↓{fmtTokens(m.out)}
                  </td>
                  <td className="mono dim">{m.steps}</td>
                  <td className="mono dim">{m.toolCalls}</td>
                  <td className="mono dim">{avgDuration(m.durations)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="dim">no tasks yet — run one from the Overview tab to see per-model stats here</div>
        )}
      </section>

      <section className="info-sec">
        <h2 className="info-h">task outcomes</h2>
        {statuses.length ? (
          <div className="outcome-strip">
            {statuses.map(([status, n]) => (
              <div
                key={status}
                className="outcome-seg"
                style={{ flexGrow: n, backgroundColor: STATUS_COLORS[status] ?? "var(--fg-faint)" }}
                title={`${status}: ${n}`}
              >
                {n > 0 && (n / totalTasks) > 0.08 ? `${status} ${n}` : ""}
              </div>
            ))}
          </div>
        ) : (
          <div className="dim">—</div>
        )}
        <div className="effort-levels" style={{ marginTop: 8 }}>
          {statuses.map(([status, n]) => (
            <span key={status} className="effort-pill">
              <span style={{ color: STATUS_COLORS[status] }}>●</span> {status} {n}
            </span>
          ))}
        </div>
      </section>

      <section className="info-sec">
        <h2 className="info-h">tools</h2>
        {toolRows.length ? (
          <table className="info-table">
            <thead>
              <tr>
                <th>tool</th>
                <th>calls</th>
                <th></th>
                <th>running</th>
                <th>errors</th>
              </tr>
            </thead>
            <tbody>
              {toolRows.map(([name, st]) => (
                <tr key={name}>
                  <td className="mono">{name}</td>
                  <td className="mono">{st.calls}</td>
                  <td className="tool-bar-cell">
                    <Bar percent={(st.calls / maxToolCalls) * 100} tone={st.errors ? "tone-warn" : "tone-green"} />
                  </td>
                  <td className="mono dim">{st.running > 0 ? `↻ ${st.running}` : ""}</td>
                  <td className={`mono ${st.errors ? "fail-count" : "dim"}`}>{st.errors || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="dim">no tool calls observed yet (live since this page connected)</div>
        )}
      </section>
    </div>
  );
}
