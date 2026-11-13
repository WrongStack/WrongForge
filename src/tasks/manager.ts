/**
 * Task manager — runs tasks for the orchestrator and tells it everything.
 *
 * Lifecycle:  queued -> running -> completed | failed | cancelled | timed_out
 *
 * - Concurrency: at most `maxConcurrency` tasks run at once; the rest wait in
 *   a FIFO queue. Tasks of the SAME session never overlap (a session is one
 *   conversation), they run in submission order.
 * - Every state change and every agent action becomes a TaskEvent with a
 *   per-task, gap-free `seq`. Events are (1) appended to events.jsonl,
 *   (2) written to the JSONL log, (3) pushed to live subscribers (SSE) and
 *   (4) POSTed to the task's webhook (if any), in that order.
 * - `task.heartbeat` events prove liveness while a task runs.
 * - Consecutive text deltas are coalesced (flush every `textFlushMs`) so a
 *   token stream does not become thousands of events.
 * - Restart safety: tasks that were queued/running when the server stopped
 *   are marked `failed` / `server_restarted` by `recover()`; their sessions
 *   keep every turn that finished before, so the caller can simply re-send.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage, ImagePart, TextPart } from "../messages.js";
import { readTaskImages, validateImages, writeTaskImages } from "../images.js";
import { runAgentTurn, type AgentEvent, type TurnResult } from "../agent.js";
import { runInContext, type TaskContext } from "../context.js";
import type { Logger } from "../log.js";
import { buildTaskPreamble, buildTaskSystemPrompt } from "../prompt.js";
import { defaultCacheMode, isCacheMode, type CacheMode } from "../cache.js";
import { defaultEffort, isEffortSetting, type EffortSetting } from "../effort.js";
import { compactMessages, contextConfigFromEnv, isCacheOrderingError, isContextOverflow, type ContextConfig } from "../compaction.js";
import type { LoadedSession } from "../sessions.js";
import { agentTools } from "../tools/index.js";
import {
  GatewayError,
  GatewayRegistry,
  allowedGatewayHosts,
  describeGateway,
  shadowedBuiltins,
  validateGatewaySpec,
  type GatewaySpec,
  type LoadedGateway,
} from "../tools/gateway.js";
import type { ToolSet } from "../tool.js";
import { McpError, defaultMcpRegistry, type McpRegistry } from "../mcp/registry.js";
import { isValidServerName } from "../mcp/config.js";
import { SessionStore } from "../sessions.js";
import { TaskStore, type TaskFilter } from "./store.js";
import { WebhookDispatcher } from "./webhook.js";
import {
  isTerminal,
  type SubmitRequest,
  type TaskError,
  type TaskEvent,
  type TaskEventType,
  type TaskRecord,
  type TaskResult,
  type TaskStatus,
} from "./types.js";

export class SubmitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ManagerOptions {
  store: TaskStore;
  sessions: SessionStore;
  client: Anthropic;
  logger: Logger;
  webhook?: WebhookDispatcher | null;
  defaultModel: string;
  /**
   * Workdir for tasks that do not name one. When unset, `workdir` is REQUIRED
   * in every task (so nothing runs in the server's own directory by accident).
   */
  defaultWorkdir?: string;
  /**
   * When set, a task's workdir must be inside one of these directories.
   * Guards where tasks START — the agent's tools are not sandboxed.
   */
  allowedRoots?: string[];
  /** Default for `workdir_lock` when a task does not say (default false). */
  defaultWorkdirLock?: boolean;
  maxConcurrency?: number; // default 2
  /**
   * Queue-flood guard for named client keys: how many QUEUED tasks one
   * non-default client may hold before further submits get 429 queue_full.
   * Default 50; 0 = unlimited; the default/admin key is never capped.
   */
  maxQueuedPerClient?: number;
  heartbeatMs?: number; // default 15 000
  defaultTimeoutMs?: number; // default 30 min
  maxTimeoutMs?: number; // default 4 h
  textFlushMs?: number; // default 300
  progressSaveMs?: number; // default 2 000
  /** Guide directory override (tests). */
  promptDir?: string;
  /** Context-window management (default: from env, see compaction.ts). */
  context?: ContextConfig;
  /** Orchestrator tool gateway (default: a registry with built-in names reserved). */
  gateways?: GatewayRegistry;
  /** Hosts a task's `gateway.url` may point to (default: loopback; "*" = any). */
  gatewayAllowedHosts?: string[];
  /** MCP client registry (default: the process-wide one on the default config file). */
  mcp?: McpRegistry;
}

/** Runtime-only data of a queued/running task. */
interface Live {
  env: Record<string, string>;
  abort: AbortController;
  ctx?: TaskContext;
  textBuf: string;
  textTimer?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
  cancelReason?: string;
  timedOut?: boolean;
  interrupted?: boolean;
  lastError?: string;
  /** Gateway incl. token/headers — memory only, never persisted. */
  gateway?: GatewaySpec;
  /** Exposed names of the orchestrator-provided tools of this task. */
  external?: Set<string>;
  done: Promise<void>;
  resolveDone: () => void;
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/**
 * A task emits nothing after one of these: unlike an intermediate event
 * (where the next heartbeat/step/tool event "heals" a dropped one), a
 * one-off durable-write hiccup here has no later chance to recover — the
 * task is already terminal, so every subscriber and its webhook would stay
 * silent about it forever. Worth a couple of immediate retries before that
 * happens (see F103).
 */
const TERMINAL_EVENT_TYPES: ReadonlySet<TaskEventType> = new Set(["task.completed", "task.failed", "task.cancelled", "task.timed_out"]);

/** Workdir identity for locking (Windows paths are case-insensitive). */
const dirKey = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

/**
 * Resolves when `p` resolves, or after `ms` — whichever comes first. Unlike a
 * bare `Promise.race`, the deadline timer is cleared as soon as the race is
 * settled, so giving up never leaves a live timer behind that outlives the work
 * (it would keep the process alive after a cancel or after shutdown returned).
 */
function deadline(p: Promise<unknown>, ms: number): Promise<unknown> {
  let t: NodeJS.Timeout | undefined;
  const guard = new Promise<void>((r) => {
    t = setTimeout(r, ms);
  });
  return Promise.race([p, guard]).finally(() => clearTimeout(t));
}

export class TaskManager {
  private readonly o: Required<
    Pick<ManagerOptions, "maxConcurrency" | "maxQueuedPerClient" | "heartbeatMs" | "defaultTimeoutMs" | "maxTimeoutMs" | "textFlushMs" | "progressSaveMs">
  > &
    ManagerOptions;
  private live = new Map<string, Live>();
  private queue: string[] = [];
  /** Last (position, waiting_for) pair announced per queued task — see pump(). */
  private lastQueue = new Map<string, { position: number; waiting_for: "capacity" | "session" | "workdir" | null }>();
  private running = new Set<string>();
  private activeSessions = new Set<string>();
  private seqs = new Map<string, number>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private listeners = new Set<(ev: TaskEvent) => void>();
  private closing = false;
  private readonly ctxCfg: ContextConfig;
  private readonly gateways: GatewayRegistry;
  private readonly gatewayHosts: string[];
  readonly mcp: McpRegistry;

  constructor(opts: ManagerOptions) {
    this.o = {
      ...opts,
      maxConcurrency: opts.maxConcurrency ?? 2,
      maxQueuedPerClient: opts.maxQueuedPerClient ?? 50,
      heartbeatMs: opts.heartbeatMs ?? 15_000,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 30 * 60_000,
      maxTimeoutMs: opts.maxTimeoutMs ?? 4 * 3_600_000,
      textFlushMs: opts.textFlushMs ?? 300,
      progressSaveMs: opts.progressSaveMs ?? 2_000,
    };
    this.ctxCfg = opts.context ?? contextConfigFromEnv();
    this.gatewayHosts = opts.gatewayAllowedHosts ?? allowedGatewayHosts();
    this.mcp = opts.mcp ?? defaultMcpRegistry(opts.logger);
    this.gateways =
      opts.gateways ?? new GatewayRegistry({ reservedNames: new Set(Object.keys(agentTools)), logger: opts.logger });
  }

  /** Effective context-management settings (for /v1/info). */
  get contextConfig(): ContextConfig {
    return this.ctxCfg;
  }

  // ------------------------------------------------------------------ public

  get maxConcurrency(): number {
    return this.o.maxConcurrency;
  }

  counts(): { queued: number; running: number } {
    return { queued: this.queue.length, running: this.running.size };
  }

  /** Is a task of this session queued or running? */
  sessionInUse(sessionId: string): boolean {
    if (this.activeSessions.has(sessionId)) return true;
    return this.queue.some((id) => this.o.store.get(id)?.session_id === sessionId);
  }

  /** Sessions with a queued or running task (maintenance must not touch them). */
  busySessions(): Set<string> {
    const s = new Set(this.activeSessions);
    for (const id of this.queue) {
      const r = this.o.store.get(id);
      if (r) s.add(r.session_id);
    }
    return s;
  }

  get(id: string): TaskRecord | undefined {
    return this.o.store.get(id);
  }

  list(filter?: TaskFilter): TaskRecord[] {
    return this.o.store.list(filter);
  }

  /** Tasks visible to `client` — "default" is the admin view and sees every client. */
  listFor(client: string, filter: TaskFilter = {}): TaskRecord[] {
    return this.list(client === "default" ? filter : { ...filter, client });
  }

  /** A task is visible to `client`? Foreign tasks answer 404, never 403, so
   *  a client cannot even learn that someone else's task id exists. */
  visibleTo(id: string, client: string): boolean {
    const rec = this.o.store.get(id);
    if (!rec) return false;
    return client === "default" || (rec.client ?? "default") === client;
  }

  events(id: string, after = 0, limit = 1000): TaskEvent[] {
    return this.o.store.readEvents(id, after, limit);
  }

  /**
   * The newest task events ACROSS tasks (heartbeats skipped) — the global
   * SSE feed's backlog replay. Reads the on-disk event logs, so it survives
   * serve restarts: a dashboard opened late still sees what ran while it was
   * away, not just what happened since the process started.
   */
  recentEvents(limit = 300): TaskEvent[] {
    const out: TaskEvent[] = [];
    for (const t of this.o.store.list({ limit: 25 })) {
      const evs = this.o.store.readEvents(t.id, 0, 5000);
      for (let i = Math.max(0, evs.length - limit); i < evs.length; i++) {
        if (evs[i]!.type !== "task.heartbeat") out.push(evs[i]!);
      }
      if (out.length >= limit * 4) break; // enough overlap to pick the newest `limit`
    }
    out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.task_id < b.task_id ? -1 : 1));
    return out.slice(-limit);
  }

  /** Live event feed (all tasks). Returns the unsubscribe function. */
  subscribe(listener: (ev: TaskEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when the task reached a terminal state (immediately if it already has). */
  async waitFor(id: string): Promise<TaskRecord | undefined> {
    const live = this.live.get(id);
    if (live) await live.done;
    return this.o.store.get(id);
  }

  /**
   * Validates and enqueues a task. Idempotent on `task_id`: re-sending the
   * same id returns the existing task (`deduplicated: true`).
   */
  submit(req: SubmitRequest, client = "default"): { task: TaskRecord; deduplicated: boolean } {
    if (this.closing) throw new SubmitError(503, "shutting_down", "server is shutting down");
    const o = this.o;
    const bad: (code: string, msg: string) => never = (code, msg) => {
      throw new SubmitError(400, code, msg);
    };

    // ---- validation
    if (typeof req.prompt !== "string" || !req.prompt.trim()) bad("invalid_request", "`prompt` (non-empty string) is required");
    if (req.prompt.length > 200_000) bad("invalid_request", "`prompt` is too long (max 200000 chars)");

    if (req.task_id !== undefined && !TaskStore.isValidId(req.task_id)) {
      bad("invalid_request", "`task_id` must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    }
    if (req.session_id !== undefined && !SessionStore.isValidId(req.session_id)) {
      bad("invalid_request", "`session_id` must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
    }

    // ---- idempotency
    if (req.task_id && o.store.has(req.task_id)) {
      const existing = o.store.get(req.task_id)!;
      const samePrompt = existing.prompt === req.prompt;
      const sameSession = req.session_id === undefined || existing.session_id === req.session_id;
      if ((existing.client ?? "default") !== client) {
        // never echo another client's task back, and never let a foreign
        // client "deduplicate" into it (409, not 403 — same conflict family
        // as a prompt mismatch, and it does not confirm anything else)
        throw new SubmitError(409, "task_id_conflict", `task_id "${req.task_id}" belongs to another client`);
      }
      if (!samePrompt || !sameSession) {
        throw new SubmitError(409, "task_id_conflict", `task_id "${req.task_id}" already exists with a different prompt/session`);
      }
      return { task: existing, deduplicated: true };
    }

    // ---- image attachments (validateImages: whitelist, ≤ 5 MB each,
    // ≤ 5 images, magic bytes must match the declared media type)
    const imagesCheck = validateImages(req.images);
    if ("error" in imagesCheck) bad("invalid_request", imagesCheck.error);
    const validatedImages = imagesCheck.images;

    const model = req.model ?? o.defaultModel;
    if (typeof model !== "string" || !MODEL_RE.test(model)) bad("invalid_request", "`model` is not a valid model id");

    const maxSteps = req.max_steps ?? 50;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 500) bad("invalid_request", "`max_steps` must be an integer 1-500");

    const timeoutMs = req.timeout_ms ?? o.defaultTimeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > o.maxTimeoutMs) {
      bad("invalid_request", `\`timeout_ms\` must be an integer 1000-${o.maxTimeoutMs}`);
    }

    const workdir = this.resolveWorkdir(req.workdir);
    if (req.workdir_lock !== undefined && typeof req.workdir_lock !== "boolean") {
      bad("invalid_request", "`workdir_lock` must be a boolean");
    }
    const workdirLock = req.workdir_lock ?? this.o.defaultWorkdirLock ?? false;

    if (req.cache !== undefined && !isCacheMode(req.cache)) bad("invalid_request", '`cache` must be "5m", "1h" or "off"');
    const cache: CacheMode = req.cache ?? defaultCacheMode();

    if (req.effort !== undefined && !isEffortSetting(req.effort)) {
      bad("invalid_request", '`effort` must be "low", "medium", "high" or "off"');
    }
    const effort: EffortSetting = req.effort ?? defaultEffort();

    if (req.priority !== undefined && req.priority !== "low" && req.priority !== "normal") {
      bad("invalid_request", '`priority` must be "low" or "normal"');
    }

    const env: Record<string, string> = {};
    if (req.env !== undefined) {
      if (typeof req.env !== "object" || req.env === null || Array.isArray(req.env)) bad("invalid_request", "`env` must be an object of strings");
      const entries = Object.entries(req.env);
      if (entries.length > 50) bad("invalid_request", "`env` may have at most 50 variables");
      for (const [k, v] of entries) {
        if (!ENV_KEY_RE.test(k)) bad("invalid_request", `invalid env variable name: ${k}`);
        if (typeof v !== "string" || v.length > 8192) bad("invalid_request", `env value of ${k} must be a string (max 8192 chars)`);
        env[k] = v;
      }
    }

    if (req.system_append !== undefined && (typeof req.system_append !== "string" || req.system_append.length > 20_000)) {
      bad("invalid_request", "`system_append` must be a string (max 20000 chars)");
    }

    if (req.callback !== undefined) {
      const cb = req.callback;
      if (typeof cb !== "object" || cb === null || typeof cb.url !== "string") bad("invalid_request", "`callback.url` is required");
      let u: URL;
      try {
        u = new URL(cb.url);
      } catch {
        return bad("invalid_request", "`callback.url` is not a valid URL");
      }
      if (u.protocol !== "http:" && u.protocol !== "https:") bad("invalid_request", "`callback.url` must be http(s)");
      if (cb.events !== undefined && (!Array.isArray(cb.events) || cb.events.length > 30 || cb.events.some((e) => typeof e !== "string"))) {
        bad("invalid_request", "`callback.events` must be an array of up to 30 strings");
      }
      if (!o.webhook) bad("callbacks_disabled", "this server has webhooks disabled");
    }

    let gateway: GatewaySpec | undefined;
    if (req.gateway !== undefined) {
      try {
        gateway = validateGatewaySpec(req.gateway, this.gatewayHosts);
      } catch (e) {
        if (e instanceof GatewayError) bad(e.code, e.message);
        throw e;
      }
    }

    let builtinTools: string[] | undefined;
    if (req.builtin_tools !== undefined) {
      if (!Array.isArray(req.builtin_tools) || req.builtin_tools.length > 50 || req.builtin_tools.some((n) => typeof n !== "string")) {
        bad("invalid_request", "`builtin_tools` must be an array of up to 50 tool names");
      }
      const unknown = req.builtin_tools.filter((n) => !Object.hasOwn(agentTools, n));
      if (unknown.length) bad("invalid_request", `\`builtin_tools\`: unknown built-in tool(s) ${unknown.join(", ")} (see GET /v1/tools)`);
      builtinTools = [...new Set(req.builtin_tools)];
    }

    let mcpSelection: string[] | undefined;
    if (req.mcp !== undefined) {
      if (!Array.isArray(req.mcp) || req.mcp.length > 50 || req.mcp.some((n) => typeof n !== "string")) {
        bad("invalid_request", '`mcp` must be an array of up to 50 server names (or ["*"])');
      }
      const known = this.mcp.store.readAll().servers;
      for (const n of req.mcp) {
        if (n === "*") continue;
        if (!isValidServerName(n)) bad("invalid_request", `\`mcp\`: "${n}" is not a valid server name`);
        if (!known.has(n)) bad("unknown_mcp_server", `\`mcp\`: no MCP server named "${n}" is configured (see GET /v1/mcp/servers)`);
      }
      mcpSelection = [...new Set(req.mcp)];
    }

    // ---- queue-flood guard (named client keys): a runaway orchestrator must
    // not be able to fill the shared queue with hundreds of waiting tasks —
    // the same starvation family as issue #7, one level earlier. Only counts
    // QUEUED tasks (running slots are bounded by max_concurrency + fair
    // share); the default/admin key is never capped so operator tooling and
    // pre-0.4.17 single-key setups keep working unchanged. Checked here,
    // before the session is created, so a rejection leaves no state behind.
    const cap = this.o.maxQueuedPerClient;    if (client !== "default" && cap > 0) {
      const queued = this.queue.filter((id) => (this.o.store.get(id)!.client ?? "default") === client).length;
      if (queued >= cap) {
        throw new SubmitError(429, "queue_full", `client "${client}" already has ${queued} queued tasks (WRONGFORGE_MAX_QUEUED_PER_CLIENT=${cap}) — cancel some or wait for slots`);
      }
    }

    // ---- session (create when missing). Sessions are owned by their
    // creator's client: a second orchestrator pointing at the same
    // session_id would silently merge conversation histories, so a foreign
    // client is refused instead (sessions that predate client keys belong to
    // the default key).
    let sessionId = req.session_id;
    let sessionCreated = false;
    if (!sessionId) {
      sessionId = `ses_${crypto.randomBytes(8).toString("hex")}`;
    }
    if (o.sessions.exists(sessionId)) {
      const owner = o.sessions.meta(sessionId)?.owner ?? "default";
      if (owner !== client) {
        throw new SubmitError(403, "session_not_owned", `session "${sessionId}" belongs to another client`);
      }
    } else {
      o.sessions.create(sessionId, new Date(), client);
      sessionCreated = true;
    }

    // ---- record
    const id = req.task_id ?? `tsk_${crypto.randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    const rec: TaskRecord = {
      id,
      status: "queued",
      session_id: sessionId,
      session_created: sessionCreated,
      prompt: req.prompt,
      model,
      max_steps: maxSteps,
      timeout_ms: timeoutMs,
      cache,
      effort,
      ...(req.priority === "low" ? { priority: "low" as const } : {}),
      workdir,
      workdir_lock: workdirLock,
      env_keys: Object.keys(env),
      ...(req.system_append ? { system_append: req.system_append } : {}),
      ...(req.context !== undefined ? { context: req.context } : {}),
      ...(req.callback ? { callback: { url: req.callback.url, events: req.callback.events }, callback_stats: { delivered: 0, failed: 0 } } : {}),
      ...(gateway ? { gateway: describeGateway(gateway) } : {}),
      ...(mcpSelection ? { mcp: mcpSelection } : {}),
      ...(builtinTools ? { builtin_tools: builtinTools } : {}),
      ...(client !== "default" ? { client } : {}),
      created_at: now,
      progress: { steps: 0, tool_calls: 0, last_event_seq: 0, last_activity_at: now },
    };
    o.store.put(rec);

    // ---- images: validated already; persist the decoded bytes as files in
    // the task dir and keep only the references on the record — megabytes of
    // base64 never land in task.json, the audit trail or the logs.
    if (validatedImages.length) {
      rec.images = writeTaskImages(path.join(o.store.dir, id), validatedImages);
      o.store.put(rec);
    }

    o.logger.info("task.submitted", {
      task_id: id, session_id: sessionId, session_created: sessionCreated, model, workdir, workdir_lock: workdirLock, cache, effort,
      priority: rec.priority ?? "normal", client,
      max_steps: maxSteps, timeout_ms: timeoutMs, env_keys: rec.env_keys, has_callback: Boolean(rec.callback),
      prompt: rec.prompt, context: rec.context,
    });

    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    this.live.set(id, { env, gateway, abort: new AbortController(), textBuf: "", done, resolveDone });
    this.seqs.set(id, 0);
    this.queue.push(id);
    // the task is in the queue now, so blockReason sees the full picture —
    // including fair-share, so a task queued into a fair-blocked slot
    // announces "capacity" right away instead of a null that pump would
    // immediately contradict with a queue_update
    const queuedWaiting = this.blockReason(rec, this.fairShareBlocks(rec));
    this.emit(id, "task.queued", {
      position: this.queue.length - 1,
      // why it cannot start right now: capacity | session | workdir (null = it starts immediately)
      waiting_for: queuedWaiting,
      session_id: sessionId,
      session_created: sessionCreated,
      workdir,
    });
    // task.queued already announced this state — don't repeat it on the next pump
    this.lastQueue.set(id, { position: this.queue.length - 1, waiting_for: queuedWaiting });
    this.pump();
    return { task: rec, deduplicated: false };
  }

  /**
   * Cancels a task. Queued: immediately. Running: aborts the model call and
   * the running shell command, resolves when the task has reached `cancelled`
   * (or after 10 s). Finished tasks are returned unchanged.
   */
  async cancel(id: string, reason?: string): Promise<{ task: TaskRecord; already_finished: boolean } | undefined> {
    const rec = this.o.store.get(id);
    if (!rec) return undefined;
    if (isTerminal(rec.status)) return { task: rec, already_finished: true };
    const live = this.live.get(id)!;
    live.cancelReason = reason?.slice(0, 500) || "cancelled by caller";

    const qi = this.queue.indexOf(id);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.finalize(id, "cancelled", {});
    } else {
      live.abort.abort();
      await deadline(live.done, 10_000);
    }
    return { task: this.o.store.get(id)!, already_finished: false };
  }

  /**
   * Startup recovery: tasks that were queued/running when the server stopped
   * are finished as `failed` / `server_restarted` (and their webhook fires).
   */
  recover(): string[] {
    const stale = this.o.store.list({ status: ["queued", "running"], limit: Number.MAX_SAFE_INTEGER });
    for (const rec of stale) {
      this.seqs.set(rec.id, this.o.store.lastSeq(rec.id));
      this.live.set(rec.id, {
        env: {}, abort: new AbortController(), textBuf: "", done: Promise.resolve(), resolveDone: () => undefined,
      });
      this.finalize(rec.id, "failed", {
        error: { code: "server_restarted", message: "the server stopped while this task was queued or running; re-send it (same session_id continues the conversation)" },
      });
    }
    if (stale.length) this.o.logger.warn("tasks.recovered", { count: stale.length, task_ids: stale.map((t) => t.id) });
    return stale.map((t) => t.id);
  }

  /** Graceful stop: no new tasks, running ones are interrupted, deliveries flushed. */
  async shutdown(graceMs = 10_000): Promise<void> {
    this.closing = true;
    for (const id of [...this.queue]) {
      this.queue.splice(this.queue.indexOf(id), 1);
      this.live.get(id)!.interrupted = true;
      this.finalize(id, "failed", {
        error: { code: "server_restarted", message: "the server was shut down before this task started" },
      });
    }
    const pending: Promise<void>[] = [];
    for (const id of this.running) {
      const live = this.live.get(id)!;
      live.interrupted = true;
      live.abort.abort();
      pending.push(live.done);
    }
    await deadline(Promise.all(pending), graceMs);
    await deadline(this.o.webhook?.idle() ?? Promise.resolve(), graceMs);
    // Flush-only was not enough: a retrying webhook kept calling out long after
    // we reported "stopped", because nothing cancelled its backoff (F934).
    // close() signals synchronously, so the bound below is a wait, not a gate.
    await deadline(this.o.webhook?.close() ?? Promise.resolve(), graceMs);
    this.flushSaves();
  }

  // ----------------------------------------------------------------- internal

  /**
   * Turns the requested workdir into a canonical absolute path (symlinks
   * resolved, so `..` tricks and links cannot slip past `allowedRoots`).
   */
  private resolveWorkdir(requested?: string): string {
    if (requested === undefined && !this.o.defaultWorkdir) {
      throw new SubmitError(400, "workdir_required", "`workdir` is required (the server has no default workdir configured)");
    }
    if (requested !== undefined && (typeof requested !== "string" || !requested.trim())) {
      throw new SubmitError(400, "invalid_request", "`workdir` must be a non-empty string");
    }
    const base = this.o.defaultWorkdir ?? process.cwd();
    const wanted = path.resolve(base, requested ?? ".");
    let dir: string;
    try {
      dir = fs.realpathSync(wanted);
      if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new SubmitError(400, "invalid_workdir", `workdir is not an existing directory: ${wanted}`);
    }
    const roots = this.o.allowedRoots;
    if (roots && roots.length) {
      const inside = roots.some((r) => {
        let root = path.resolve(r);
        try {
          root = fs.realpathSync(root);
        } catch {
          /* keep the unresolved root */
        }
        const rel = path.relative(root, dir);
        return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
      });
      if (!inside) throw new SubmitError(403, "workdir_not_allowed", `workdir is outside the allowed roots: ${dir}`);
    }
    return dir;
  }

  /** Starts queued tasks while there is capacity. */
  private pump(): void {
    if (this.closing) return;
    // Scan the queue in order. A task that cannot start holds back LATER tasks
    // of the same session (a session's tasks keep their order) and, if it wants
    // the workdir exclusively, later tasks of that workdir (no starvation).
    const holdSessions = new Set<string>();
    const holdDirs = new Set<string>();
    for (let i = 0; i < this.queue.length; ) {
      if (this.running.size >= this.o.maxConcurrency) break;
      const id = this.queue[i]!;
      const rec = this.o.store.get(id)!;
      const key = dirKey(rec.workdir);
      const fair = this.fairShareBlocks(rec);
      if (holdSessions.has(rec.session_id) || holdDirs.has(key) || this.blockReason(rec, fair) !== null) {
        holdSessions.add(rec.session_id);
        if (rec.workdir_lock) holdDirs.add(key);
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      this.lastQueue.delete(id);
      this.running.add(id);
      this.activeSessions.add(rec.session_id);
      void this.execute(id).catch((e) => {
        // execute() handles its own errors; this is a last-resort guard
        this.o.logger.error("task.internal_error", { task_id: id, error: e });
        if (!isTerminal(this.o.store.get(id)!.status)) {
          this.finalize(id, "failed", { error: { code: "internal_error", message: String((e as Error)?.message ?? e) } });
        }
      });
    }
    // A queued task's position and block reason change only when the queue or
    // the running set changes — exactly the moments that reach this method.
    // Announce every QUEUED task whose (position, waiting_for) pair moved so
    // clients watching the event stream see queue progress without polling
    // (issue #7: a task can sit in the queue for minutes in total silence).
    this.queue.forEach((id, position) => {
      const rec = this.o.store.get(id)!;
      const waiting = this.blockReason(rec, this.fairShareBlocks(rec));
      const prev = this.lastQueue.get(id);
      if (prev && prev.position === position && prev.waiting_for === waiting) return;
      this.lastQueue.set(id, { position, waiting_for: waiting });
      this.emit(id, "task.queue_update", { position, waiting_for: waiting, priority: rec.priority ?? "normal" });
    });
  }

  /**
   * Why `rec` cannot start right now (null = it can):
   *  - capacity: all slots are busy — or, for a low-priority task, all but the
   *    one slot every server keeps free for normal tasks (issue #7: helper
   *    tasks submitted as `priority: "low"` may fill at most
   *    max_concurrency - 1 slots, so the leader's next model call always has
   *    a slot to take) — or, for a client that already holds
   *    max_concurrency - 1 slots, the last slot while ANOTHER client has a
   *    startable task waiting (fair share across orchestrators; a
   *    single-client install never sees this)
   *  - session:  another task of the same session is running
   *  - workdir:  another task runs in the same workdir and one of the two wants exclusivity
   * @param fairShare precomputed fair-share verdict (pump passes it so the
   *   queue is not rescanned; the O(queue) scan lives in fairShareBlocks)
   */
  private blockReason(rec: TaskRecord, fairShare = false): "capacity" | "session" | "workdir" | null {
    if (this.activeSessions.has(rec.session_id)) return "session";
    const key = dirKey(rec.workdir);
    for (const rid of this.running) {
      const r = this.o.store.get(rid)!;
      if (dirKey(r.workdir) === key && (rec.workdir_lock || r.workdir_lock)) return "workdir";
    }
    const limit = rec.priority === "low" ? this.o.maxConcurrency - 1 : this.o.maxConcurrency;
    if (this.running.size >= limit) return "capacity";
    if (fairShare) return "capacity";
    return null;
  }

  /**
   * True when taking one more slot for `rec` would fill the server with a
   * single client's tasks while another client has a startable task queued —
   * the multi-client version of the low-priority reservation. The last slot
   * then stays free for the other client's head-of-queue work, so two
   * orchestrators interleave instead of one hogging every slot. Never fires
   * with max_concurrency 1 (it would invert FIFO into starvation) or for
   * low-priority tasks (their reservation is stricter already).
   */
  private fairShareBlocks(rec: TaskRecord): boolean {
    if (this.o.maxConcurrency < 2 || rec.priority === "low") return false;
    if (this.running.size !== this.o.maxConcurrency - 1) return false;
    const mine = rec.client ?? "default";
    for (const rid of this.running) {
      if ((this.o.store.get(rid)!.client ?? "default") !== mine) return false; // another client already holds a slot
    }
    // would this task complete the client's sweep of every slot? then hold it
    // only while a DIFFERENT client has a startable task waiting
    return this.queue.some((qid) => {
      const other = this.o.store.get(qid)!;
      if ((other.client ?? "default") === mine) return false;
      return this.startableIgnoringCapacity(other);
    });
  }

  /** Everything except the capacity check — would this queued task start if a slot were open? */
  private startableIgnoringCapacity(rec: TaskRecord): boolean {
    if (this.activeSessions.has(rec.session_id)) return false;
    const key = dirKey(rec.workdir);
    for (const rid of this.running) {
      const r = this.o.store.get(rid)!;
      if (dirKey(r.workdir) === key && (rec.workdir_lock || r.workdir_lock)) return false;
    }
    return !(rec.priority === "low" && this.running.size >= this.o.maxConcurrency - 1);
  }

  /**
   * Live queue facts for one still-queued task — what GET /v1/tasks/:id
   * reports as `queue_position` / `waiting_for` while status is "queued".
   */
  queueInfoOf(id: string): { position: number; waiting_for: "capacity" | "session" | "workdir" | null } | undefined {
    const position = this.queue.indexOf(id);
    if (position < 0) return undefined;
    return { position, waiting_for: this.blockReason(this.o.store.get(id)!) };
  }

  private async execute(id: string): Promise<void> {
    const o = this.o;
    const cfg = this.ctxCfg;
    const rec = o.store.get(id)!;
    const live = this.live.get(id)!;

    rec.status = "running";
    rec.started_at = new Date().toISOString();
    this.saveNow(rec);
    const startedAt = Date.now();

    // Loaded before live.ctx (and before it used to be loaded, further
    // down) because a session's prompt-cache mode is locked in by its first
    // turn: Anthropic requires a consistent TTL ordering across the whole
    // cached prefix, and cache.ts only ever marks the NEWEST message — it
    // never touches an older cache_control already embedded in history. A
    // later turn using a different `cache` mode than an earlier one on the
    // same session would put an inconsistent TTL in front of that history,
    // which the API rejects outright. A per-task `cache` override therefore
    // only has effect on the turn that creates the session (sessions.ts's
    // `cache_mode` field, set once in appendTurn and never overwritten).
    let session = o.sessions.load(rec.session_id);
    const effectiveCache: CacheMode = session?.meta.cache_mode ?? rec.cache;
    if (effectiveCache !== rec.cache) {
      o.logger.warn("session.cache_mode_locked", { task_id: id, session_id: rec.session_id, requested: rec.cache, locked: effectiveCache });
      this.emit(id, "session.cache_mode_locked", { requested: rec.cache, locked: effectiveCache });
      rec.cache = effectiveCache; // reflects what is actually used, e.g. in GET /v1/tasks/:id
      this.saveNow(rec);
    }

    live.ctx = {
      taskId: id,
      sessionId: rec.session_id,
      cwd: rec.workdir,
      env: live.env,
      todos: [],
      cache: rec.cache,
      effort: rec.effort,
      mcp: this.mcp,
      report: (r) => {
        rec.progress.last_report = { ...r, at: new Date().toISOString() };
        this.emit(id, "agent.report", { message: r.message, percent: r.percent, phase: r.phase });
      },
    };

    // Timers start first: heartbeat and timeout also cover compaction and tool discovery.
    live.heartbeat = setInterval(() => {
      this.emit(id, "task.heartbeat", {
        elapsed_ms: Date.now() - startedAt,
        steps: rec.progress.steps,
        tool_calls: rec.progress.tool_calls,
        current_tool: rec.progress.current_tool ?? null,
        last_activity_at: rec.progress.last_activity_at,
      });
    }, o.heartbeatMs);
    live.heartbeat.unref();
    live.timeout = setTimeout(() => {
      live.timedOut = true;
      live.abort.abort();
    }, rec.timeout_ms);
    live.timeout.unref();
    const stopTimers = (): void => {
      clearInterval(live.heartbeat);
      clearTimeout(live.timeout);
    };

    this.emit(id, "task.started", {
      model: rec.model, workdir: rec.workdir, session_id: rec.session_id, session_created: rec.session_created,
      // set when this session last worked somewhere else (paths in its history may not apply)
      ...(session?.meta.workdir && dirKey(session.meta.workdir) !== dirKey(rec.workdir)
        ? { session_workdir_changed_from: session.meta.workdir }
        : {}),
      resumed_messages: session?.messages.length ?? 0,
      context_tokens: session?.meta.context_tokens ?? null,
      cache: rec.cache, effort: rec.effort, max_steps: rec.max_steps, timeout_ms: rec.timeout_ms,
    });

    // ---- 1. keep the session inside the context window (summarize old turns)
    try {
      session = await this.compactIfNeeded(id, session, false);
    } catch (e) {
      if (!live.abort.signal.aborted) {
        o.logger.warn("session.compaction_failed", { task_id: id, session_id: rec.session_id, error: e });
      }
    }

    // ---- 2. tools provided by the orchestrator (WrongStack)
    let extraTools: ToolSet = {};
    let shadowed: string[] = [];
    if (live.gateway && !live.abort.signal.aborted) {
      try {
        const loaded: LoadedGateway = await this.gateways.load(
          live.gateway,
          { taskId: id, sessionId: rec.session_id, workdir: rec.workdir },
          live.abort.signal,
        );
        extraTools = loaded.tools;
        if (rec.gateway) rec.gateway.tool_names = loaded.defs.map((d) => d.exposed);
        // The orchestrator's tools win: `wstack_read` hides the local `read`
        // so the model cannot route around WrongStack (gateway.shadow_builtins
        // === false keeps both).
        if (live.gateway.shadow_builtins !== false) {
          shadowed = shadowedBuiltins(
            loaded.defs.map((d) => d.exposed),
            live.gateway.name_prefix ?? "wstack_",
            Object.keys(agentTools),
          );
          if (shadowed.length) rec.gateway && (rec.gateway.shadowed_builtins = shadowed);
        }
        this.emit(id, "tools.loaded", {
          source: live.gateway.tools ? "inline" : "discovery",
          url: live.gateway.url,
          count: loaded.defs.length,
          tools: loaded.defs.map((d) => d.exposed),
          hash: loaded.hash,
          cached: loaded.cached,
          shadowed,
          warnings: loaded.warnings.concat(shadowed.map((n) => `shadowed built-in "${n}" (use the ${live.gateway!.name_prefix ?? "wstack_"}${n} tool)`)),
        });
      } catch (e) {
        if (!live.abort.signal.aborted) {
          const msg = (e as Error).message;
          if (live.gateway.optional) {
            this.emit(id, "tools.loaded", { source: "discovery", url: live.gateway.url, count: 0, tools: [], error: msg, warnings: [] });
          } else {
            stopTimers();
            return this.finalize(id, "failed", { error: { code: "tool_gateway_unavailable", message: msg } });
          }
        }
      }
    }
    // ---- 2b. MCP servers: their tools, typed, as mcp_<server>_<tool>
    if (!live.abort.signal.aborted) {
      try {
        const m = await this.mcp.loadForTask(rec.mcp, { taskId: id }, live.abort.signal);
        if (m.servers.length) {
          this.emit(id, "tools.loaded", {
            source: "mcp",
            servers: m.servers,
            count: m.defs.length,
            tools: m.defs.map((d) => d.exposed),
            hash: m.hash,
            warnings: m.warnings,
          });
        }
        extraTools = { ...extraTools, ...m.tools };
      } catch (e) {
        if (!live.abort.signal.aborted) {
          if (e instanceof McpError && e.code === "mcp_unavailable") {
            stopTimers();
            return this.finalize(id, "failed", { error: { code: "mcp_unavailable", message: e.message } });
          }
          // a broken config file must not take every task down: continue without eager MCP tools
          o.logger.warn("mcp.load_failed", { task_id: id, error: e });
          this.emit(id, "tools.loaded", { source: "mcp", servers: [], count: 0, tools: [], warnings: [(e as Error).message] });
        }
      }
    }
    const externalNames = new Set(Object.keys(extraTools));
    live.external = externalNames;

    /** Shadowed built-ins are removed from whatever allowlist applies. */
    const effectiveBuiltins = shadowed.length
      ? (rec.builtin_tools ?? Object.keys(agentTools)).filter((n) => !shadowed.includes(n))
      : rec.builtin_tools;

    // ---- 3. run the turn (one automatic retry after a context overflow)
    // Task-specific facts live in the user message so the system prompt (and
    // with it the cached prefix of the session) stays identical across tasks.
    const userMessage = `${buildTaskPreamble({ taskId: id, cwd: rec.workdir })}\n\n${rec.prompt}`;
    // submitted images ride as inline content blocks in the FIRST user
    // message (read back from the task dir — the base64 never sat in the
    // record or the session store at submit time)
    const taskImages = rec.images?.length
      ? readTaskImages(path.join(o.store.dir, id), rec.images)
      : [];
    const firstContent: (TextPart | ImagePart)[] = [
      ...taskImages.map((img) => ({ type: "image" as const, media_type: img.media_type, data: img.data })),
      { type: "text" as const, text: userMessage },
    ];
    const system = buildTaskSystemPrompt({ systemAppend: rec.system_append, promptDir: o.promptDir });
    const guard = { clearAt: cfg.clearAt, keepToolResults: cfg.keepToolResults, maxToolResultChars: cfg.maxToolResultChars };

    let history: AgentMessage[] = [];
    let mark = 0;
    let turn: TurnResult | null = null;
    let thrown: unknown;
    let retried = false;
    for (;;) {
      const base: AgentMessage[] = session?.messages ?? [];
      history = [...base, { role: "user", content: taskImages.length ? firstContent : userMessage }];
      mark = base.length;
      turn = null;
      thrown = undefined;
      live.lastError = undefined;
      try {
        turn = await runInContext(live.ctx, () =>
          runAgentTurn(o.client, rec.model, history, rec.max_steps, live.abort.signal, (e) => this.onAgentEvent(id, e), system, guard, extraTools, effectiveBuiltins),
        );
      } catch (e) {
        thrown = e;
      }
      if (live.abort.signal.aborted) break;

      // the stream's own error (the API's words) is more specific than the SDK's generic "no output" error
      const failedText = `${live.lastError ?? ""} ${(thrown as Error)?.message ?? ""}`;
      // Both are fixed by the same compaction: context overflow summarizes
      // away the bulk of the history; a cache-ordering error (an earlier
      // turn's cache_control TTL now sorts "after" a newer one, see
      // compaction.ts's isCacheOrderingError) is fixed too because the
      // offending older messages get summarized away rather than re-sent.
      const recoverableByCompaction = (thrown || turn?.finishReason === "error") && (isContextOverflow(failedText) || isCacheOrderingError(failedText));
      // only safe to redo when nothing has been executed yet (no side effects)
      if (recoverableByCompaction && !retried && rec.progress.tool_calls === 0 && session && session.messages.length > 0) {
        retried = true;
        try {
          const compacted = await this.compactIfNeeded(id, session, true);
          if (compacted && compacted !== session) {
            session = compacted;
            continue;
          }
        } catch (e) {
          o.logger.warn("session.compaction_failed", { task_id: id, session_id: rec.session_id, error: e });
        }
      }
      break;
    }

    stopTimers();
    this.flushText(id);
    const durationMs = Date.now() - startedAt;

    // Builds the same TaskResult shape (context_tokens/window/percent and
    // everything else) regardless of outcome. Used on failure paths too
    // (context_overflow, cache_ordering_error) whenever `turn` is available —
    // agent.ts keeps context_tokens current (including the estimate from a
    // just-appended tool result) even when a turn ends in error, so a caller
    // can tell HOW CLOSE it got, not just that it failed. Only absent when
    // `turn` itself never came back (a rarer failure before any turn ran).
    const buildResult = (t: TurnResult): TaskResult => ({
      text: t.text,
      finish_reason: t.finishReason,
      steps: t.steps,
      tool_calls: t.toolCalls,
      usage: t.usage,
      context_tokens: t.context_tokens,
      context_window: cfg.window,
      context_percent: Math.round((t.context_tokens / cfg.window) * 1000) / 10,
      duration_ms: durationMs,
    });

    // ---- classify the outcome
    if (live.abort.signal.aborted || turn?.finishReason === "aborted") {
      if (live.interrupted) {
        return this.finalize(id, "failed", { error: { code: "server_restarted", message: "the server was shut down while this task was running" } });
      }
      return this.finalize(id, live.timedOut ? "timed_out" : "cancelled", {});
    }
    if (thrown || !turn || turn.finishReason === "error") {
      const msg = String(live.lastError ?? (thrown as Error)?.message ?? "unknown error").slice(0, 2000);
      if (isContextOverflow(msg)) {
        o.sessions.patchMeta(rec.session_id, { needs_compaction: true });
        return this.finalize(id, "failed", {
          ...(turn ? { result: buildResult(turn) } : {}),
          error: {
            code: "context_overflow",
            message: `the conversation does not fit the model's context window (${msg.slice(0, 300)}). The session is marked for compaction: send the task again with the same session_id, or start a new session.`,
          },
        });
      }
      if (isCacheOrderingError(msg)) {
        // Same recovery as context_overflow: the next task on this session
        // compacts first (compactIfNeeded's "flagged_after_overflow" reason),
        // which drops the older messages carrying the inconsistent TTL.
        o.sessions.patchMeta(rec.session_id, { needs_compaction: true });
        return this.finalize(id, "failed", {
          ...(turn ? { result: buildResult(turn) } : {}),
          error: {
            code: "cache_ordering_error",
            message: `the session's cached prefix has an inconsistent cache TTL ordering (${msg.slice(0, 300)}). The session is marked for compaction: send the task again with the same session_id, or start a new session.`,
          },
        });
      }
      return this.finalize(id, "failed", { ...(turn ? { result: buildResult(turn) } : {}), error: { code: "agent_error", message: msg } });
    }

    const result: TaskResult = buildResult(turn);

    // finishReason comes from the Anthropic API (agent.ts): end_turn /
    // stop_sequence = done, tool_use = the step budget ran out while the
    // model still wanted tools, max_tokens = output limit.
    const commitable = ["end_turn", "stop_sequence", "tool_use", "max_tokens"].includes(turn.finishReason);
    if (commitable) {
      try {
        o.sessions.appendTurn(rec.session_id, history.slice(mark), {
          task_id: id, model: rec.model, prompt: rec.prompt, workdir: rec.workdir, context_tokens: turn.context_tokens, cache_mode: rec.cache,
        });
      } catch (e) {
        return this.finalize(id, "failed", {
          result,
          error: { code: "internal_error", message: `could not save the session: ${(e as Error).message}` },
        });
      }
    }

    if (turn.finishReason === "end_turn" || turn.finishReason === "stop_sequence") {
      return this.finalize(id, "completed", { result });
    }
    if (turn.finishReason === "tool_use") {
      return this.finalize(id, "failed", {
        result,
        error: { code: "max_steps", message: `stopped after ${rec.max_steps} steps before the model finished; the work so far is in the session — send a follow-up task with the same session_id to continue` },
      });
    }
    if (turn.finishReason === "max_tokens") {
      return this.finalize(id, "failed", { result, error: { code: "max_tokens", message: "the model hit its output limit" } });
    }
    return this.finalize(id, "failed", {
      result,
      error: { code: "agent_error", message: live.lastError ?? `model finished with reason "${turn.finishReason}"` },
    });
  }

  /**
   * Summarizes the session's old turns when its context is too large (or when
   * `force`d after an overflow). Returns the (possibly new) loaded session.
   */
  private async compactIfNeeded(id: string, session: LoadedSession | null, force: boolean): Promise<LoadedSession | null> {
    if (!session) return session;
    const o = this.o;
    const cfg = this.ctxCfg;
    const rec = o.store.get(id)!;
    const live = this.live.get(id)!;
    const m = session.meta;
    const reason = force
      ? "context_overflow"
      : m.needs_compaction
        ? "flagged_after_overflow"
        : cfg.compactAt > 0 && (m.context_tokens ?? 0) >= cfg.compactAt
          ? "threshold"
          : null;
    if (!reason) return session;

    this.emit(id, "session.compacting", {
      reason, context_tokens: m.context_tokens ?? null, threshold: cfg.compactAt, messages: session.messages.length, keep_turns: cfg.keepTurns,
    });
    const res = await compactMessages(o.client, cfg.summaryModel ?? rec.model, session.messages, cfg.keepTurns, live.abort.signal);
    if (!res) {
      this.emit(id, "session.compacted", { compacted: false, note: `nothing to summarize (${cfg.keepTurns} or fewer turns)` });
      return session;
    }
    const { archive } = await o.sessions.replaceMessages(rec.session_id, res.messages);
    this.emit(id, "session.compacted", {
      compacted: true,
      messages_before: res.messages_before,
      messages_after: res.messages_after,
      turns_summarized: res.turns_summarized,
      turns_kept: res.turns_kept,
      summary_chars: res.summary.length,
      archive,
    });
    return o.sessions.load(rec.session_id);
  }

  /**
   * Manual compaction (POST /v1/sessions/:id/compact). Refuses while a task of
   * the session is queued or running.
   */
  async compactSession(
    sessionId: string,
    model?: string,
  ): Promise<{ compacted: boolean; messages_before: number; messages_after: number; turns_summarized: number; archive?: string; meta: unknown }> {
    const o = this.o;
    const loaded = o.sessions.load(sessionId);
    if (!loaded) throw new SubmitError(404, "no_such_session", `no such session: ${sessionId}`);
    if (this.sessionInUse(sessionId)) throw new SubmitError(409, "session_busy", "a task of this session is queued or running");
    const res = await compactMessages(o.client, this.ctxCfg.summaryModel ?? model ?? o.defaultModel, loaded.messages, this.ctxCfg.keepTurns);
    if (!res) {
      return { compacted: false, messages_before: loaded.messages.length, messages_after: loaded.messages.length, turns_summarized: 0, meta: loaded.meta };
    }
    // F1301: the sessionInUse check above ran BEFORE the summarizer's network
    // round-trip. A task submitted for this session during those seconds can
    // start AND complete its turn before we get here — installing the summary
    // built from the pre-task snapshot would then silently drop that turn
    // from the session's live history (it would survive only in the archive
    // file). A completed-inside-the-window task is invisible to a
    // sessionInUse re-check (it already left activeSessions), so instead
    // compare against the snapshot the summary was built from: turns are only
    // ever APPENDED (appendTurn), so any change in the stored history means
    // the summary no longer describes what a reader would resume from.
    const current = o.sessions.load(sessionId);
    if (!current || current.meta.message_count !== loaded.meta.message_count || current.messages.length !== loaded.messages.length) {
      throw new SubmitError(
        409,
        "session_busy",
        "the session changed while the summary was being written; it was left unchanged — retry the compaction",
      );
    }
    const { archive, meta } = await o.sessions.replaceMessages(sessionId, res.messages);
    o.logger.info("session.compacted", {
      session_id: sessionId, manual: true, messages_before: res.messages_before, messages_after: res.messages_after, archive,
    });
    return { compacted: true, messages_before: res.messages_before, messages_after: res.messages_after, turns_summarized: res.turns_summarized, archive, meta };
  }

  private onAgentEvent(id: string, e: AgentEvent): void {
    const rec = this.o.store.get(id)!;
    const live = this.live.get(id)!;
    switch (e.type) {
      case "step_start":
        this.flushText(id);
        rec.progress.steps = e.step;
        this.emit(id, "step.started", { step: e.step });
        break;
      case "step_request":
        this.emit(id, "step.request", {
          step: e.step, model: e.model, effort: e.effort, max_tokens: e.max_tokens, messages: e.messages, tools: e.tools,
        });
        break;
      case "step_finish":
        this.flushText(id);
        this.emit(id, "step.finished", { step: e.step, finish_reason: e.finish_reason, usage: e.usage, context_tokens: e.context_tokens });
        break;
      case "context_cleared":
        this.emit(id, "context.cleared", { cleared: e.cleared, context_tokens: e.context_tokens });
        break;
      case "text":
        live.textBuf += e.delta;
        if (live.textBuf.length >= 4000) this.flushText(id);
        else if (!live.textTimer) live.textTimer = setTimeout(() => this.flushText(id), this.o.textFlushMs);
        break;
      case "tool_call":
        rec.progress.tool_calls++;
        if (e.name === "report_progress") break; // surfaced as agent.report by the tool itself
        this.flushText(id);
        rec.progress.current_tool = { id: e.id, name: e.name, started_at: new Date().toISOString() };
        this.emit(id, "tool.started", {
          tool_call_id: e.id, name: e.name, ...(live.external?.has(e.name) ? { external: true } : {}), input: e.input,
        });
        break;
      case "tool_result": {
        if (e.name === "report_progress") break;
        rec.progress.current_tool = undefined;
        const ok = (e.output as { ok?: unknown } | null)?.ok;
        this.emit(id, "tool.finished", {
          tool_call_id: e.id, name: e.name, ...(live.external?.has(e.name) ? { external: true } : {}),
          ...(typeof ok === "boolean" ? { ok } : {}), output: e.output,
        });
        if (e.name === "todo_write" && ok === true && live.ctx) {
          rec.progress.todos = live.ctx.todos;
          this.emit(id, "agent.todos", { todos: live.ctx.todos });
        }
        break;
      }
      case "tool_error":
        rec.progress.current_tool = undefined;
        this.emit(id, "tool.failed", { tool_call_id: e.id, name: e.name, error: e.error });
        break;
      case "error":
        live.lastError = e.error;
        this.o.logger.warn("task.model_error", { task_id: id, error: e.error });
        break;
    }
  }

  private flushText(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    if (live.textTimer) {
      clearTimeout(live.textTimer);
      live.textTimer = undefined;
    }
    if (live.textBuf) {
      const text = live.textBuf;
      live.textBuf = "";
      this.emit(id, "agent.text", { text });
    }
  }

  /** Writes + distributes one event. Synchronous, so order == emit order. */
  private emit(id: string, type: TaskEventType, data: Record<string, unknown>): TaskEvent {
    const o = this.o;
    const rec = o.store.get(id)!;
    const seq = (this.seqs.get(id) ?? o.store.lastSeq(id)) + 1;
    this.seqs.set(id, seq);
    const ts = new Date().toISOString();
    const ev: TaskEvent = { seq, ts, task_id: id, session_id: rec.session_id, type, data };

    // A terminal event gets a couple of immediate retries: it is the task's
    // last word, so a one-off hiccup (e.g. a brief antivirus/indexer file
    // lock on Windows) must not cost it forever — there is no later event
    // to carry the notification instead (F103). An intermediate event is
    // not retried: the next one already heals the stream, exactly as today.
    const attempts = TERMINAL_EVENT_TYPES.has(type) ? 3 : 1;
    let wrote = false;
    let lastErr: unknown;
    for (let i = 0; i < attempts && !wrote; i++) {
      try {
        o.store.appendEvent(ev);
        wrote = true;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!wrote) {
      o.logger.error(attempts > 1 ? "task.terminal_event_lost" : "task.event_write_failed", {
        task_id: id, seq, type, attempts, error: lastErr,
      });
      // The event never reached the durable log, so nothing can replay it.
      // Give the seq back (events.jsonl stays gap-free, as documented) and do
      // not hand a seq to a subscriber or the webhook that no reader would
      // ever be able to resume from.
      this.seqs.set(id, seq - 1);
      return ev;
    }
    rec.progress.last_event_seq = seq;
    if (type !== "task.heartbeat") rec.progress.last_activity_at = ts;
    this.scheduleSave(rec);

    o.logger.info(type, { task_id: id, session_id: rec.session_id, seq, ...data });

    for (const l of this.listeners) {
      try {
        l(ev);
      } catch {
        /* a broken subscriber must not break the task */
      }
    }
    if (rec.callback && o.webhook) {
      o.webhook.enqueue(rec.callback, ev, (r) => {
        const st = (rec.callback_stats ??= { delivered: 0, failed: 0 });
        if (r.ok) st.delivered++;
        else {
          st.failed++;
          st.last_error = r.error;
        }
        this.scheduleSave(rec);
      });
    }
    return ev;
  }

  /** Moves a task to a terminal state, emits the terminal event, frees resources. */
  private finalize(
    id: string,
    status: Exclude<TaskStatus, "queued" | "running">,
    extra: { result?: TaskResult; error?: TaskError },
  ): void {
    const rec = this.o.store.get(id)!;
    const live = this.live.get(id);
    if (isTerminal(rec.status)) return;

    this.flushText(id);
    if (live) {
      clearInterval(live.heartbeat);
      clearTimeout(live.timeout);
    }
    rec.status = status;
    rec.finished_at = new Date().toISOString();
    rec.progress.current_tool = undefined;
    if (extra.result) rec.result = extra.result;
    if (extra.error) rec.error = extra.error;
    if (status === "cancelled") rec.cancel_reason = live?.cancelReason;

    switch (status) {
      case "completed":
        this.emit(id, "task.completed", { result: rec.result });
        break;
      case "failed":
        this.emit(id, "task.failed", { error: rec.error, ...(rec.result ? { result: rec.result } : {}) });
        break;
      case "cancelled":
        this.emit(id, "task.cancelled", { reason: rec.cancel_reason });
        break;
      case "timed_out":
        this.emit(id, "task.timed_out", { timeout_ms: rec.timeout_ms });
        break;
    }
    this.saveNow(rec);

    this.running.delete(id);
    this.activeSessions.delete(rec.session_id);
    this.seqs.delete(id);
    this.live.delete(id);
    this.lastQueue.delete(id);
    live?.resolveDone();
    this.pump();
  }

  /** Debounced save (progress changes often; the file does not need every tick). */
  private scheduleSave(rec: TaskRecord): void {
    if (this.saveTimers.has(rec.id)) return;
    const t = setTimeout(() => {
      this.saveTimers.delete(rec.id);
      this.o.store.put(rec);
    }, this.o.progressSaveMs);
    t.unref();
    this.saveTimers.set(rec.id, t);
  }

  private saveNow(rec: TaskRecord): void {
    const t = this.saveTimers.get(rec.id);
    if (t) {
      clearTimeout(t);
      this.saveTimers.delete(rec.id);
    }
    this.o.store.put(rec);
  }

  /** Writes every record with a pending debounced save (shutdown). */
  private flushSaves(): void {
    for (const [id, t] of this.saveTimers) {
      clearTimeout(t);
      const rec = this.o.store.get(id);
      if (rec) this.o.store.put(rec);
    }
    this.saveTimers.clear();
  }
}
