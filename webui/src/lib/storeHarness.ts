/**
 * Test seam for the dashboard's live path — test-only; the app never imports
 * it. A test file swaps the api module for it:
 *
 *   vi.mock("../lib/api.js", async () => await import("../lib/storeHarness.js"));
 *
 * Same exports as api.ts: `api` answers the store's snapshot routes from
 * `fake` instead of the network, `connectEvents` hands the store's own frame
 * handler to the test instead of opening /v1/events, and `loadKey` /
 * `saveKey` do nothing. `connectStore()` connects the singleton store;
 * `push(frame)` then delivers a frame exactly as the real stream would —
 * `http.request` lands in the feed and the http counters, `proxy.call` in the
 * Proxy tab, everything else in the task fold.
 *
 * The store is a singleton: each connect replaces the snapshot (tasks,
 * sessions, info, usage), but the feed, the proxy calls and the http counters
 * keep accumulating across a file's tests — scope assertions to what the test
 * pushed, or put order-sensitive cases first.
 */
import { vi } from "vitest";
import type { Info, PlanUsage, ProxyCall, TaskEvent } from "./types.js";

export type Frame = TaskEvent | ProxyCall | Record<string, unknown>;
type OnEvent = (ev: TaskEvent) => void;
type OnStatus = (s: string, detail?: string) => void;

/** What the fake server answers. `routes` are exact-path overrides: return the body or throw. */
export const fake = {
  info: null as unknown,
  tasks: [] as unknown[],
  sessions: [] as unknown[],
  usage: null as unknown,
  routes: new Map<string, () => unknown>(),
  /** every path asked of the fake server, in order */
  calls: [] as string[],
};

let onEvent: OnEvent | null = null;
let onStatus: OnStatus | null = null;

const emptyBucket = () => ({
  tasks: 0, completed: 0, failed: 0, cancelled: 0, timed_out: 0,
  input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, fresh_input_tokens: 0, duration_ms: 0,
});

/**
 * Per-call overrides still work (`api.mockRejectedValueOnce`, …): they replace
 * one call, the default answers the rest. The three parameters mirror
 * api.ts's, so a test can read `api.mock.calls[i]` as `[path, key, init]`.
 */
export const api = vi.fn(async (path: string, _key?: string, _init?: RequestInit): Promise<unknown> => {
  fake.calls.push(path);
  const route = fake.routes.get(path);
  if (route) return route();
  if (path === "/v1/info") return fake.info;
  if (path.startsWith("/v1/tasks?limit=300")) return { tasks: fake.tasks };
  if (path === "/v1/sessions") return { sessions: fake.sessions };
  if (path === "/v1/usage") return fake.usage;
  if (path.startsWith("/v1/usage/summary")) {
    return { days: 7, scope: { client: null, model: null }, totals: emptyBucket(), by_day: [], by_client: {}, by_model: {} };
  }
  if (/\/events\?limit=\d+$/.test(path)) return { events: [] };
  if (path === "/v1/tools") return { tools: [] };
  throw new Error(`unexpected api call: ${path}`);
});

/** Stands in for GET /v1/events: keeps the store's frame handler for `push()`. */
export function connectEvents(_key: string, onEvent_: OnEvent, onStatus_: OnStatus): () => void {
  onEvent = onEvent_;
  onStatus = onStatus_;
  return () => undefined;
}

export const loadKey = (): string => "";
export const saveKey = (): void => undefined;

/** Lets pending promise jobs (a snapshot refresh the store started) run. */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Connects the store against the fake server. `open()` reports the stream as up; `setConn()` reports any other stream state, as the real client would. */
export async function connectStore(
  snapshot: { info?: unknown; tasks?: unknown[]; sessions?: unknown[]; usage?: unknown; routes?: Map<string, () => unknown> } = {},
): Promise<{ push: (frame: Frame) => void; open: () => Promise<void>; setConn: (state: string, detail?: string) => void }> {
  const { store } = await import("./store.js");
  const { routes, ...rest } = snapshot;
  Object.assign(fake, rest);
  fake.calls.length = 0;
  fake.routes = new Map(routes ?? []);
  await store.connect("test-key");
  return {
    push: (frame) => onEvent!(frame as TaskEvent),
    open: async () => {
      onStatus!("open");
      await flush();
    },
    setConn: (state, detail) => onStatus!(state, detail),
  };
}

// ------------------------------------------------------------------ fixtures

export const NOW = "2026-11-28T12:00:00.000Z";

let seq = 0;

/** A task event frame as the server sends it. */
export const ev = (task_id: string, type: string, data: Record<string, unknown> = {}, ts: string = NOW): TaskEvent => ({
  seq: ++seq,
  ts,
  task_id,
  session_id: "ses_x",
  type,
  data,
});

/**
 * An `http.request` tap frame: top-level fields, no task envelope. Stamped a
 * few ms into the future of the real clock so every frame is a distinct tuple
 * (the store drops replays) that still counts as "just now" in its meters.
 */
export const httpFrame = (method: string, path: string, status: number, duration_ms = 12): Record<string, unknown> => ({
  type: "http.request",
  ts: new Date(Date.now() + (++seq % 50)).toISOString(),
  method,
  path,
  status,
  duration_ms,
});

/** A `proxy.call` frame as the proxy tap sends it. */
export const proxyCall = (over: Partial<ProxyCall> = {}): ProxyCall => ({
  type: "proxy.call",
  id: `pc_${++seq}`,
  ts: NOW,
  method: "POST",
  path: "/v1/messages",
  status: 200,
  duration_ms: 840,
  auth_mode: "oauth",
  model: "claude-sonnet-5-5",
  stream: true,
  request_body: { model: "claude-sonnet-5-5", messages: [{ role: "user", content: "list the files" }], tools: [{ name: "bash" }] },
  request_truncated: false,
  response_body: { stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 20 }, content: [{ type: "text", text: "a.ts b.ts" }] },
  response_truncated: false,
  ...over,
});

/** A full GET /v1/info document — spread and override in a test. */
export const fullInfo: Info = {
  name: "WrongForge",
  version: "0.4.27",
  protocol: 2,
  features: ["tasks", "proxy", "webhooks"],
  signed_in: true,
  default_model: "claude-sonnet-5-5",
  models: ["claude-sonnet-5-5", "claude-opus-5-5", "m-mini"],
  model_details: [
    { id: "claude-sonnet-5-5", description: "balanced", effort_levels: ["low", "medium", "high"] },
    { id: "claude-opus-5-5", description: "deep reasoning", effort_levels: ["low", "medium", "high"] },
    { id: "m-mini", description: "", effort_levels: [] },
  ],
  queue: { queued: 0, running: 0, max_concurrency: 2 },
  workdir: { default: "/work", required: false, allowed_roots: ["/work", "/tmp"], lock_by_default: false },
  context: { window: 200_000, compact_at: 160_000, clear_at: 185_000, keep_turns: 2 },
  cache: { default: "5m", modes: ["5m", "1h", "off"] },
  effort: { default: "medium", levels: ["low", "medium", "high"] },
  tools: ["bash", "read", "write", "edit"],
  tool_guides: ["edit: never rewrite whole files"],
  mcp: { config_file: "/data/mcp.json", servers: 1 },
  limits: { max_body_bytes: 40_000_000, max_steps: 500, default_max_steps: 50 },
  webhook: { signature: "sha256=abc", key: "whsec_test" },
  dirs: { home: "/data", logs: "/data/logs", tasks: "/data/tasks", sessions: "/data/sessions" },
};

/** A GET /v1/usage document; `weekly: null` means no weekly window. */
export function planUsage(o: { fiveHour?: number | null; weekly?: number | null; extra?: boolean } = {}): PlanUsage {
  const extra = o.extra ?? false;
  return {
    five_hour: { percent: o.fiveHour ?? 0, resetsAt: "2026-11-28T15:00:00.000Z", isActive: true },
    weekly: o.weekly == null ? null : { percent: o.weekly, resetsAt: "2026-11-30T00:00:00.000Z", isActive: true },
    extra_usage: {
      enabled: extra,
      usedCredits: extra ? 120 : null,
      monthlyLimit: extra ? 500 : null,
      utilization: extra ? 0.24 : null,
    },
  };
}
