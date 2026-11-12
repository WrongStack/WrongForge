/**
 * The dashboard's single source of truth.
 *
 * A snapshot (GET /v1/info, /v1/tasks, /v1/sessions, /v1/usage) is merged with
 * the live global feed (GET /v1/events SSE): every task event updates the task
 * documents, the aggregate counters and the graph pulses, so all views stay
 * consistent without per-view polling. React binds via useSyncExternalStore.
 */

import { useSyncExternalStore } from "react";
import { api, connectEvents, saveKey, type SseStatus } from "./api.js";
import type { Info, PlanUsage, ProxyCall, SessionMeta, TaskEvent, TaskRecord, TokenUsage } from "./types.js";

const FEED_CAP = 1200;
const PER_TASK_CAP = 600;
const PROXY_CALLS_CAP = 300;

export interface FeedRow {
  key: string;
  at: number;
  ev: TaskEvent;
}

export interface ToolStat {
  calls: number;
  errors: number;
  running: number;
  lastAt: number;
}

export interface Totals {
  steps: number;
  requests: number;
  toolCalls: number;
  in: number;
  out: number;
  cacheRead: number;
}

/** Live HTTP-traffic picture for the top bar: counters + the latest request. */
export interface HttpLive {
  total: number;
  errors: number;
  /** arrival timestamps (ms) of the last ≤2 minutes — the req/min meter. */
  times: number[];
  last: { method: string; path: string; status: number; duration_ms: number; at: number } | null;
}

export type ConnectionState = "locked" | SseStatus;

export interface State {
  key: string;
  conn: ConnectionState;
  /** Why the live feed is down (last SSE error), shown in the banner. */
  connDetail: string | null;
  info: Info | null;
  usage: PlanUsage | null;
  tasks: Map<string, TaskRecord>;
  sessions: SessionMeta[];
  feed: FeedRow[];
  /** The "Proxy" tab's own feed: /v1/messages-surface calls, kept out of
   *  `feed` so their (potentially large) bodies never ride the task firehose. */
  proxyCalls: ProxyCall[];
  perTask: Map<string, TaskEvent[]>;
  tools: Map<string, ToolStat>;
  totals: Totals;
  /** live HTTP traffic (server replay + live taps) for the top bar. */
  http: HttpLive;
  /** ms timestamp of the very last event of any kind — drives "idle Xs". */
  lastActivityAt: number;
  /** edge-id / node-id -> last-activity ts, drives the graph animations. */
  pulses: Map<string, number>;
  authError: string | null;
  /** Last action failure (test task/cancel), shown as a toast; null = none. */
  actionError: string | null;
}

const initial: State = {
  key: "",
  conn: "locked",
  connDetail: null,
  info: null,
  usage: null,
  tasks: new Map(),
  sessions: [],
  feed: [],
  proxyCalls: [],
  perTask: new Map(),
  tools: new Map(),
  totals: { steps: 0, requests: 0, toolCalls: 0, in: 0, out: 0, cacheRead: 0 },
  http: { total: 0, errors: 0, times: [], last: null },
  lastActivityAt: 0,
  pulses: new Map(),
  authError: null,
  actionError: null,
};

type Listener = () => void;

export class Store {
  private state: State = initial;
  private listeners = new Set<Listener>();
  private disconnect: (() => void) | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private seeded = false;
  private httpSeq = 0;
  /** Highest event seq already applied, per task. The backlog replays past events
   * and a reconnect replays them again, and the server's seq is gap-free per
   * task, so "at or below the watermark" identifies a replay exactly — with one
   * number per task instead of one key per event. */
  private appliedSeq = new Map<string, number>();
  /** Same, for http.request frames: they carry no id and the server replays
   * the whole tap log to every reconnect, so they are keyed by their tuple. */
  private tapKeys = new Set<string>();
  /** proxy.call frames DO carry a server-assigned id, so dedup here is exact
   *  (no tuple-hash heuristic needed, unlike tapKeys above). */
  private proxyCallIds = new Set<string>();

  private static readonly TAP_KEY_CAP = 600;
  private static readonly TASK_SEQ_CAP = 5_000;

  /** Records `seq` as applied for `taskId`, returning false if it is a replay. */
  private noteApplied(taskId: string, seq: number): boolean {
    if (seq <= (this.appliedSeq.get(taskId) ?? 0)) return false; // replay / late frame
    this.appliedSeq.set(taskId, seq);
    if (this.appliedSeq.size > Store.TASK_SEQ_CAP) {
      let drop = Store.TASK_SEQ_CAP >> 2;
      for (const id of this.appliedSeq.keys()) {
        this.appliedSeq.delete(id);
        if (--drop <= 0) break;
      }
    }
    return true;
  }

  /** True when `key` is new; records it, evicting the oldest quarter at the cap. */
  private remember(seen: Set<string>, key: string): boolean {
    if (seen.has(key)) return false;
    if (seen.size >= Store.TAP_KEY_CAP) {
      let drop = Store.TAP_KEY_CAP >> 2;
      for (const old of seen) {
        seen.delete(old);
        if (--drop <= 0) break;
      }
    }
    seen.add(key);
    return true;
  }

  getState = (): State => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private set(patch: (s: State) => Partial<State>): void {
    this.state = { ...this.state, ...patch(this.state) };
    this.emit();
  }

  // ------------------------------------------------------------ connection

  /** Validate the key, load the snapshot, start the live feed. */
  async connect(key: string): Promise<boolean> {
    if (!key.trim()) return false;
    let info: Info;
    try {
      info = await api<Info>("/v1/info", key);
    } catch (e) {
      this.set(() => ({ authError: (e as Error).message }));
      return false;
    }
    saveKey(key);
    this.set(() => ({ key, info, authError: null, conn: "connecting" }));
    await this.refresh();
    this.disconnectSse();
    this.disconnect = connectEvents(
      key,
      (ev) => {
        if (ev.type === "http.request") this.applyHttp(ev as unknown as Parameters<Store["applyHttp"]>[0]);
        else if (ev.type === "proxy.call") this.applyProxyCall(ev as unknown as ProxyCall);
        else this.applyEvent(ev);
      },
      (s, detail) => {
        this.set(() => ({ conn: s, connDetail: s === "open" ? null : (detail ?? this.state.connDetail) }));
        if (s === "open") void this.refresh(); // live-only feed: catch up after a gap
      },
    );
    if (!this.usageTimer) {
      this.usageTimer = setInterval(() => void this.refreshUsage(), 90_000);
    }
    void this.refreshUsage();
    return true;
  }

  disconnectSse(): void {
    this.disconnect?.();
    this.disconnect = null;
  }

  shutdown(): void {
    this.disconnectSse();
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
  }

  /** Snapshot of everything queryable; keeps tasks/sessions fresh. */
  async refresh(): Promise<void> {
    const key = this.state.key;
    if (!key) return;
    try {
      const [tasksRes, sessionsRes] = await Promise.all([
        api<{ tasks: TaskRecord[] }>("/v1/tasks?limit=300", key),
        api<{ sessions: SessionMeta[] }>("/v1/sessions", key),
      ]);
      this.set((s) => {
        // The snapshot was produced BEFORE this await resolved, so a live
        // event that landed in the meantime is newer for the fields it owns.
        const tasks = new Map<string, TaskRecord>();
        for (const snap of tasksRes.tasks) {
          const live = s.tasks.get(snap.id);
          tasks.set(snap.id, live ? mergeTask(snap, live) : snap);
        }
        return {
          tasks,
          sessions: sessionsRes.sessions,
          // keep events of tasks the list no longer returns (retention) — the
          // detail view reads them until the task is dismissed
          perTask: new Map([...s.perTask].filter(([id]) => tasks.has(id) || s.perTask.get(id)!.length < PER_TASK_CAP)),
        };
      });
      if (!this.seeded) {
        this.seeded = true;
        await this.seedFeed(tasksRes.tasks.slice(0, 3).map((t) => t.id));
      }
    } catch {
      /* transient — the next reconnect retries */
    }
  }

  /**
   * The global feed is live-only, so a freshly opened dashboard would stare
   * at "waiting for events…". Seed it with the recent past: the events of
   * the newest few tasks (heartbeats skipped), merged with anything that
   * already arrived live.
   */
  private async seedFeed(ids: string[]): Promise<void> {
    const rows: FeedRow[] = [];
    for (const id of ids) {
      try {
        const res = await api<{ events: TaskEvent[] }>(`/v1/tasks/${id}/events?limit=2000`, this.state.key);
        for (const ev of res.events) {
          if (ev.type === "task.heartbeat") continue;
          rows.push({ key: `${ev.task_id}:${ev.seq}`, at: Date.parse(ev.ts) || 0, ev });
        }
      } catch {
        /* task vanished mid-seed — skip it */
      }
    }
    if (!rows.length) return;
    this.set((s) => {
      const have = new Set(s.feed.map((r) => r.key));
      const merged = [...rows.filter((r) => !have.has(r.key)), ...s.feed];
      merged.sort((a, b) => a.at - b.at);
      const feed = merged.slice(-FEED_CAP);
      for (const r of feed) this.noteApplied(r.ev.task_id, r.ev.seq);
      return { feed };
    });
  }

  async refreshUsage(): Promise<void> {
    if (!this.state.key) return;
    try {
      const usage = await api<PlanUsage>("/v1/usage", this.state.key);
      this.set(() => ({ usage }));
    } catch {
      this.set(() => ({ usage: null }));
    }
  }

  // ------------------------------------------------------------- actions

  private toast(message: string): void {
    this.set(() => ({ actionError: message }));
    setTimeout(() => {
      if (this.state.actionError === message) this.set(() => ({ actionError: null }));
    }, 8_000);
  }

  dismissToast(): void {
    this.set(() => ({ actionError: null }));
  }

  /** One harmless GET so the user sees an http row land instantly. */
  async fireTestRequest(): Promise<void> {
    try {
      await api("/v1/tools", this.state.key);
    } catch (e) {
      this.toast((e as Error).message);
    }
  }

  /**
   * The "run a test task" button: a tiny real task (one ls + a fixed final
   * text, max 5 steps) so the whole pipeline — Claude round-trips, tool
   * calls, tokens — flows into the dashboard on demand.
   */
  async submitDemoTask(): Promise<void> {
    const key = this.state.key;
    if (!key) return;
    const workdir = this.state.info?.workdir;
    const dir = workdir?.default ?? workdir?.suggestion ?? null;
    if (!dir) {
      this.toast("no usable workdir: set a default workdir on the server (or its allowed_roots must include a temp path)");
      return;
    }
    try {
      await api<{ task: { id: string } }>("/v1/tasks", key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: `demo-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
          workdir: dir,
          max_steps: 5,
          prompt: '[[tool ls {"path":"."}]] [[say dashboard test ok]]',
        }),
      });
      await this.refresh(); // pick the new task document up immediately
    } catch (e) {
      this.toast((e as Error).message);
    }
  }

  /** Cancel a queued/running task; the task.cancelled event updates the UI. */
  async cancelTask(taskId: string): Promise<void> {
    try {
      await api(`/v1/tasks/${encodeURIComponent(taskId)}/cancel`, this.state.key, { method: "POST", body: "{}" });
    } catch (e) {
      this.toast((e as Error).message);
    }
  }

  /** Historical events for a task the dashboard connected after (or live tail). */
  async backfillEvents(taskId: string): Promise<void> {
    const key = this.state.key;
    if (!key) return;
    try {
      const res = await api<{ events: TaskEvent[]; terminal: boolean }>(`/v1/tasks/${taskId}/events?limit=5000`, key);
      if (!res.events.length) return;
      this.set((s) => {
        const known = s.perTask.get(taskId) ?? [];
        const seen = new Set(known.map((e) => e.seq));
        const merged = [...known, ...res.events.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
        const perTask = new Map(s.perTask);
        perTask.set(taskId, merged.slice(-PER_TASK_CAP));
        return { perTask };
      });
    } catch {
      /* task vanished — the doc fetch will surface that */
    }
  }

  // ------------------------------------------------------------ live events

  /** HTTP-traffic frame as the server sends it (top-level fields, no envelope). */
  private applyHttp(e: {
    ts?: string;
    method?: string;
    path?: string;
    status?: number;
    duration_ms?: number;
  }): void {
    // backlog frames arrive with their original ts — older than rows already
    // on screen — so the feed keeps itself ordered by event time, not arrival
    const at = Date.parse(e.ts ?? "") || Date.now();
    const status = e.status ?? 0;
    const method = e.method ?? "?";
    const path = e.path ?? "?";
    const duration = e.duration_ms ?? 0;
    // No frame id on the wire, and a reconnect replays the whole tap log: the
    // tuple is the only stable identity, so it is the dedupe key.
    if (!this.remember(this.tapKeys, `${method}|${path}|${status}|${duration}|${e.ts ?? ""}`)) return;
    const ev: TaskEvent = {
      seq: 0,
      ts: e.ts ?? new Date().toISOString(),
      task_id: "—",
      session_id: "—",
      type: "http.request",
      data: { method, path, status, duration_ms: duration },
    };
    this.set((s) => {
      const feed = [...s.feed, { key: `http:${++this.httpSeq}`, at, ev }];
      feed.sort((a, b) => a.at - b.at);
      const minuteAgo = Date.now() - 60_000;
      return {
        feed: feed.slice(-FEED_CAP),
        lastActivityAt: Date.now(),
        http: {
          total: s.http.total + 1,
          errors: s.http.errors + (status >= 400 ? 1 : 0),
          times: [...s.http.times, at].filter((t) => t > Date.now() - 120_000),
          last: { method, path, status, duration_ms: duration, at },
        },
      };
    });
  }

  /** proxy.call frame as the server sends it — flat, no TaskEvent envelope,
   *  same spirit as applyHttp() above but routed to its own `proxyCalls`
   *  list (kept out of the task firehose; see State.proxyCalls). */
  private applyProxyCall(e: ProxyCall): void {
    if (!this.remember(this.proxyCallIds, e.id)) return; // already replayed via the backlog
    const at = Date.parse(e.ts) || Date.now();
    this.set((s) => {
      const calls = [...s.proxyCalls, e];
      calls.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      return { proxyCalls: calls.slice(-PROXY_CALLS_CAP), lastActivityAt: Math.max(s.lastActivityAt, at) };
    });
  }

  applyEvent(ev: TaskEvent): void {
    if (!this.noteApplied(ev.task_id, ev.seq)) return; // already replayed via the backlog
    const key = `${ev.task_id}:${ev.seq}`;
    const at = Date.parse(ev.ts) || Date.now(); // backlog frames arrive with their real ts
    const seen = at; // activity watermark (replay keeps idle honest)
    this.set((s) => {
      const feed = [...s.feed, { key, at, ev }];
      feed.sort((a, b) => a.at - b.at); // replayed backlog can be older than live rows
      const perTask = new Map(s.perTask);
      perTask.set(ev.task_id, [...(perTask.get(ev.task_id) ?? []), ev].slice(-PER_TASK_CAP));

      const tasks = new Map(s.tasks);
      const doc = tasks.get(ev.task_id);
      if (doc) tasks.set(ev.task_id, patchTask(doc, ev));

      const tools = new Map(s.tools);
      const pulses = new Map(s.pulses);
      const totals = { ...s.totals };
      pulse(pulses, `task:${ev.task_id}`, at);

      switch (ev.type) {
        case "step.started":
          totals.steps++;
          break;
        case "step.request": {
          totals.requests++;
          pulse(pulses, `model:${String(ev.data.model ?? "")}`, at);
          pulse(pulses, `edge:${ev.task_id}>model:${String(ev.data.model ?? "")}`, at);
          break;
        }
        case "step.finished": {
          const u = ev.data.usage as TokenUsage | undefined;
          if (u) {
            totals.in += u.input_tokens ?? 0;
            totals.out += u.output_tokens ?? 0;
            totals.cacheRead += u.cache_read_tokens ?? 0;
          }
          pulse(pulses, `edge:model:${doc?.model ?? ""}>${ev.task_id}`, at);
          break;
        }
        case "tool.started": {
          const name = String(ev.data.name ?? "?");
          const st = { ...(tools.get(name) ?? { calls: 0, errors: 0, running: 0, lastAt: at }) };
          st.calls++;
          st.running++;
          st.lastAt = at;
          tools.set(name, st);
          totals.toolCalls++;
          pulse(pulses, `tool:${name}`, at);
          pulse(pulses, `edge:${ev.task_id}>tool:${name}`, at);
          break;
        }
        case "tool.finished": {
          const name = String(ev.data.name ?? "?");
          const st = { ...(tools.get(name) ?? { calls: 0, errors: 0, running: 0, lastAt: at }) };
          st.running = Math.max(0, st.running - 1);
          st.lastAt = at;
          tools.set(name, st);
          pulse(pulses, `edge:tool:${name}>${ev.task_id}`, at);
          break;
        }
        case "tool.failed": {
          const name = String(ev.data.name ?? "?");
          const st = { ...(tools.get(name) ?? { calls: 0, errors: 0, running: 0, lastAt: at }) };
          st.errors++;
          st.running = Math.max(0, st.running - 1);
          tools.set(name, st);
          break;
        }
        case "task.queued":
        case "task.started": {
          if (!doc) {
            tasks.set(ev.task_id, {
              id: ev.task_id,
              session_id: ev.session_id,
              status: ev.type === "task.queued" ? "queued" : "running",
              prompt: "",
              model: String(ev.data.model ?? ""),
              created_at: ev.ts,
              progress: {
                last_event_seq: ev.seq, steps: 0, tool_calls: 0, last_activity_at: ev.ts,
                ...(ev.type === "task.queued" ? { queue_wait: { position: Number(ev.data.position ?? 0), waiting_for: (ev.data.waiting_for as string | null) ?? null } } : {}),
              },
            } as TaskRecord);
          }
          break;
        }
      }

      // replayed backlog keeps the idle counter honest (last event's real ts)
      return { feed: feed.slice(-FEED_CAP), perTask, tasks, tools, totals, pulses, lastActivityAt: Math.max(s.lastActivityAt, at) };
    });
  }
}

function pulse(pulses: Map<string, number>, id: string, at: number): void {
  pulses.set(id, at);
}

function num(v: number | undefined): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Snapshot + live convergence: the server stays authoritative for the fields it
 * owns (prompt, workdir, result…), but a live event is newer than the snapshot
 * it raced with — keyed on the task's own event sequence, never on arrival.
 */
function mergeTask(snap: TaskRecord, live: TaskRecord): TaskRecord {
  const snapSeq = snap.progress?.last_event_seq ?? 0;
  if ((live.progress?.last_event_seq ?? 0) <= snapSeq) return snap;
  return {
    ...snap,
    status: live.status,
    started_at: live.started_at ?? snap.started_at,
    finished_at: live.finished_at ?? snap.finished_at,
    progress: live.progress,
  };
}

/** Folds an event into the task document so list views stay current. */
function patchTask(doc: TaskRecord, ev: TaskEvent): TaskRecord {
  const d: TaskRecord = { ...doc, progress: { ...doc.progress, last_event_seq: ev.seq, last_activity_at: ev.ts } };
  switch (ev.type) {
    case "task.queued":
      d.progress.queue_wait = { position: Number(ev.data.position ?? 0), waiting_for: (ev.data.waiting_for as string | null) ?? null };
      break;
    case "task.queue_update":
      d.progress.queue_wait = { position: Number(ev.data.position ?? 0), waiting_for: (ev.data.waiting_for as string | null) ?? null };
      break;
    case "task.started":
      d.status = "running";
      d.started_at = ev.ts;
      d.progress.queue_wait = undefined;
      break;
    case "task.completed":
    case "task.failed":
    case "task.cancelled":
    case "task.timed_out":
      d.status = ev.type.split(".")[1] as TaskRecord["status"];
      d.finished_at = ev.ts;
      d.progress.queue_wait = undefined;
      break;
    case "step.started":
      d.progress.steps = Math.max(d.progress.steps, Number(ev.data.step ?? 0));
      break;
    case "tool.started":
      d.progress.tool_calls++;
      d.progress.current_tool = {
        id: String(ev.data.tool_call_id ?? ""),
        name: String(ev.data.name ?? ""),
        started_at: ev.ts,
      };
      break;
    case "tool.finished":
    case "tool.failed":
      d.progress.current_tool = undefined;
      break;
    case "agent.report":
      d.progress.last_report = {
        message: String(ev.data.message ?? ""),
        percent: ev.data.percent as number | undefined,
        phase: ev.data.phase as string | undefined,
        at: ev.ts,
      };
      break;
    case "agent.todos":
      d.progress.todos = ev.data.todos as TaskRecord["progress"]["todos"];
      break;
  }
  return d;
}

export const store = new Store();

/** Binds a selector to the store (select stable references; derive in useMemo). */
export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => sel(store.getState()),
    () => sel(initial),
  );
}
