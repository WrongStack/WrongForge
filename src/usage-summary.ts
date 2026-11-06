/**
 * Task-usage aggregation for GET /v1/usage/summary.
 *
 * Every finished task's `result.usage` already holds its FULL token
 * consumption (agent.ts sums all steps), so summing task records gives an
 * accurate picture without touching event logs. Pure function — the route
 * owns scoping (a named client only ever receives its own records).
 */

import type { TaskRecord } from "./tasks/types.js";

export interface UsageBucket {
  /** Tasks in the bucket (any status). */
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  timed_out: number;
  /** Summed over finished tasks: all input tokens (cache included). */
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Input tokens NOT served from the cache — the fresh input. */
  fresh_input_tokens: number;
  /** Wall-clock of finished tasks, summed. */
  duration_ms: number;
}

export interface UsageSummary {
  generated_at: string;
  /** How far back the aggregation reaches (UTC days). */
  days: number;
  scope: {
    /** Fixed when the caller is a named client or passes ?client=. */
    client: string | null;
    model: string | null;
  };
  totals: UsageBucket;
  /** UTC date (YYYY-MM-DD of created_at) → bucket, oldest first. */
  by_day: Array<{ date: string } & UsageBucket>;
  by_client: Record<string, UsageBucket>;
  by_model: Record<string, UsageBucket>;
}

export interface UsageSummaryOptions {
  /** Reach this many UTC days back from now (created_at based). */
  days: number;
  /** Non-null pins the client scope (named callers / ?client=). */
  client?: string | null;
  model?: string | null;
  now?: Date;
}

const emptyBucket = (): UsageBucket => ({
  tasks: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  fresh_input_tokens: 0, duration_ms: 0,
});

function addTo(bucket: UsageBucket, rec: TaskRecord): void {
  bucket.tasks++;
  if (rec.status === "completed") bucket.completed++;
  else if (rec.status === "failed") bucket.failed++;
  else if (rec.status === "cancelled") bucket.cancelled++;
  else if (rec.status === "timed_out") bucket.timed_out++;
  const u = rec.result?.usage;
  if (u) {
    bucket.input_tokens += u.input_tokens;
    bucket.output_tokens += u.output_tokens;
    bucket.cache_read_tokens += u.cache_read_tokens;
    bucket.cache_write_tokens += u.cache_write_tokens;
    bucket.fresh_input_tokens += Math.max(0, u.input_tokens - u.cache_read_tokens);
  }
  if (rec.result?.duration_ms) bucket.duration_ms += rec.result.duration_ms;
}

/**
 * Aggregates task records into totals plus by-day / by-client / by-model
 * buckets. `records` should already be scoped to what the caller may see;
 * `options.client`/`model` narrow it further and are echoed in the scope.
 */
export function summarizeUsage(records: TaskRecord[], options: UsageSummaryOptions): UsageSummary {
  const now = options.now ?? new Date();
  const cutoff = now.getTime() - options.days * 24 * 3600 * 1000;
  const totals = emptyBucket();
  const byDay = new Map<string, UsageBucket>();
  const byClient = new Map<string, UsageBucket>();
  const byModel = new Map<string, UsageBucket>();

  for (const rec of records) {
    const created = Date.parse(rec.created_at);
    if (!Number.isFinite(created) || created < cutoff) continue;
    if (options.model && rec.model !== options.model) continue;

    addTo(totals, rec);
    const day = new Date(created).toISOString().slice(0, 10);
    addTo(byDay.get(day) ?? byDay.set(day, emptyBucket()).get(day)!, rec);
    const clientKey = rec.client ?? "default";
    addTo(byClient.get(clientKey) ?? byClient.set(clientKey, emptyBucket()).get(clientKey)!, rec);
    addTo(byModel.get(rec.model) ?? byModel.set(rec.model, emptyBucket()).get(rec.model)!, rec);
  }

  const dateAsc = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  const toRecord = (m: Map<string, UsageBucket>): Record<string, UsageBucket> => Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return {
    generated_at: now.toISOString(),
    days: options.days,
    scope: { client: options.client ?? null, model: options.model ?? null },
    totals,
    by_day: [...byDay.entries()].map(([date, b]) => ({ date, ...b })).sort(dateAsc),
    by_client: toRecord(byClient),
    by_model: toRecord(byModel),
  };
}
