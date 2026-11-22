/**
 * Server-side usage history section (GET /v1/usage/summary) — beyond the
 * live window the store can see, including the per-client breakdown a
 * named-key page cannot get otherwise. Lives in its own file so the
 * fetch/render logic is testable without the singleton store (see
 * UsageSection.test.tsx); InsightsView renders it with the page's key.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { Bar, Chip } from "./bits.js";
import { fmtTokens } from "../lib/types.js";

interface Bucket {
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  timed_out: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  fresh_input_tokens: number;
  duration_ms: number;
}

interface UsageSummary {
  days: number;
  scope: { client: string | null; model: string | null };
  totals: Bucket;
  by_day: Array<{ date: string } & Bucket>;
  by_client: Record<string, Bucket>;
  by_model: Record<string, Bucket>;
}

const DAY_CHOICES = [7, 30, 90];

/** Compact wall-clock: 45s · 12m · 3.1h · 2d. */
function fmtMs(ms: number): string {
  if (ms >= 172_800_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 7_200_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  if (ms >= 120_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

export function UsageSection({ clientKey }: { clientKey: string }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await api<UsageSummary>(`/v1/usage/summary?days=${days}`, clientKey));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [days, clientKey]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const days_ = data?.by_day ?? [];
  const maxDayIn = Math.max(1, ...days_.map((b) => b.input_tokens));
  const clientBuckets = Object.entries(data?.by_client ?? {});

  return (
    <section className="info-sec">
      <div className="feed-toolbar" style={{ justifyContent: "space-between" }}>
        <h2 className="info-h" style={{ margin: 0 }}>
          usage history{data?.scope.client ? ` · ${data.scope.client}` : ""}
        </h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="seg seg-mini">
            {DAY_CHOICES.map((d) => (
              <button key={d} className={`seg-item ${days === d ? "on" : ""}`} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
          <button className="banner-btn" onClick={() => void load()}>
            refresh
          </button>
        </div>
      </div>
      {error ? (
        <div className="dim">
          {error} — <button className="banner-btn" onClick={() => void load()}>retry</button>
        </div>
      ) : !data ? (
        <div className="dim">loading…</div>
      ) : (
        <>
          <div className="insp-grid">
            <Chip label="tasks" value={String(data.totals.tasks)} />
            <Chip label="completed" value={String(data.totals.completed)} tone="tone-green" />
            <Chip label="failed" value={String(data.totals.failed + data.totals.cancelled + data.totals.timed_out)} tone={data.totals.failed + data.totals.cancelled + data.totals.timed_out ? "tone-warn" : undefined} />
            <Chip label="tokens" value={`↑${fmtTokens(data.totals.input_tokens)} ↓${fmtTokens(data.totals.output_tokens)}`} tone="tone-violet" />
            <Chip label="cache read" value={fmtTokens(data.totals.cache_read_tokens)} tone="tone-green" />
            <Chip label="cache write" value={fmtTokens(data.totals.cache_write_tokens)} />
            <Chip label="fresh input" value={fmtTokens(data.totals.fresh_input_tokens)} tone="tone-cyan" />
            <Chip label="agent time" value={fmtMs(data.totals.duration_ms)} />
          </div>

          <table className="info-table" style={{ marginTop: 10 }}>
            <thead>
              <tr>
                <th>day (UTC)</th>
                <th>tasks</th>
                <th>ok / fail</th>
                <th>input ↑</th>
                <th></th>
                <th>output ↓</th>
                <th>cache read</th>
                <th>fresh</th>
                <th>agent time</th>
              </tr>
            </thead>
            <tbody>
              {days_.map((b) => (
                <tr key={b.date}>
                  <td className="mono">{b.date}</td>
                  <td className="mono">{b.tasks}</td>
                  <td className="mono">
                    <span className="ok-count">{b.completed}</span>
                    {" / "}
                    <span className={b.failed + b.cancelled + b.timed_out ? "fail-count" : "dim"}>{b.failed + b.cancelled + b.timed_out}</span>
                  </td>
                  <td className="mono">↑{fmtTokens(b.input_tokens)}</td>
                  <td className="tool-bar-cell">
                    <Bar percent={(b.input_tokens / maxDayIn) * 100} tone="tone-violet" />
                  </td>
                  <td className="mono">↓{fmtTokens(b.output_tokens)}</td>
                  <td className="mono dim">{fmtTokens(b.cache_read_tokens)}</td>
                  <td className="mono dim">{fmtTokens(b.fresh_input_tokens)}</td>
                  <td className="mono dim">{b.duration_ms ? fmtMs(b.duration_ms) : "—"}</td>
                </tr>
              ))}
              {!days_.length && (
                <tr>
                  <td className="dim" colSpan={9}>
                    no finished tasks in this window
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {clientBuckets.length > 1 && (
            <table className="info-table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>client</th>
                  <th>tasks</th>
                  <th>ok</th>
                  <th>input ↑</th>
                  <th>output ↓</th>
                </tr>
              </thead>
              <tbody>
                {clientBuckets.map(([name, b]) => (
                  <tr key={name}>
                    <td className="mono">{name}</td>
                    <td className="mono">{b.tasks}</td>
                    <td className="mono ok-count">{b.completed}</td>
                    <td className="mono">↑{fmtTokens(b.input_tokens)}</td>
                    <td className="mono">↓{fmtTokens(b.output_tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
