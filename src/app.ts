/**
 * Wires every component together from environment variables (with overrides
 * for tests). Used by the HTTP server and by `npm run maintain`.
 *
 *   WRONGFORGE_HOME                data directory (default ~/.wrongforge)
 *   WRONGFORGE_LOG_DIR             log directory (default <home>/logs)
 *   WRONGFORGE_LOG_LEVEL           debug | info | warn | error   (default info)
 *   WRONGFORGE_LOG_STDERR=1        also print every log line to stderr
 *   WRONGFORGE_LOG_MAX_MB          size at which a day's log file rolls over (default 50)
 *   CLAUDE_MODEL                   default model (default claude-sonnet-5-5)
 *   WRONGFORGE_EFFORT              default reasoning effort low|medium|high|off (default high)
 *   WRONGFORGE_MAX_CONCURRENCY     tasks running at once (default 2)
 *   WRONGFORGE_WORKDIR             default workdir for tasks that name none (default: none -> workdir is required)
 *   WRONGFORGE_ALLOWED_ROOTS       directories tasks may start in, separated by ; (Windows) or : (others)
 *   WRONGFORGE_WORKDIR_LOCK=1      make exclusive workdirs the default
 *   WRONGFORGE_HEARTBEAT_MS        heartbeat interval (default 15000)
 *   WRONGFORGE_TASK_TIMEOUT_MS     default task timeout (default 1800000 = 30 min)
 *   WRONGFORGE_WEBHOOK_SECRET      HMAC key for webhooks (default: the API key)
 *   WRONGFORGE_WEBHOOK_MAX_ATTEMPTS  delivery attempts per event (default 6)
 * plus the variables of cache.ts, compaction.ts, maintenance.ts, prompt.ts,
 * tools/gateway.ts and mcp/*.
 */

import * as path from "node:path";
import { createClaudeClient } from "./provider.js";
import type { ClaudeOAuth } from "./oauth.js";
import { DEFAULT_MODEL } from "./agent.js";
import { Logger, type LogLevel } from "./log.js";
import { dataDir } from "./paths.js";
import { SessionStore } from "./sessions.js";
import { TaskStore } from "./tasks/store.js";
import { TaskManager, type ManagerOptions } from "./tasks/manager.js";
import { WebhookDispatcher, type WebhookOptions } from "./tasks/webhook.js";
import { retentionFromEnv, type Retention } from "./maintenance.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { defaultMcpRegistry, type McpRegistry } from "./mcp/registry.js";
import { initEffortPersistence } from "./effort.js";
import type { ContextConfig } from "./compaction.js";

export interface AppOptions {
  oauth: ClaudeOAuth;
  /** Default webhook HMAC key when WRONGFORGE_WEBHOOK_SECRET is unset. */
  apiKey: string;
  /** Base directory for logs/, tasks/, sessions/ (default: the data directory). */
  home?: string;
  logDir?: string;
  defaultModel?: string;
  maxConcurrency?: number;
  /** Queue-flood guard override for tests (env: WRONGFORGE_MAX_QUEUED_PER_CLIENT, default 50). */
  maxQueuedPerClient?: number;
  /** Per-client rate limit override for tests (env: WRONGFORGE_CLIENT_RATE_LIMIT, req/min, default 120). */
  clientRateLimit?: number;
  heartbeatMs?: number;
  textFlushMs?: number;
  progressSaveMs?: number;
  defaultTimeoutMs?: number;
  defaultWorkdir?: string;
  allowedRoots?: string[];
  defaultWorkdirLock?: boolean;
  webhook?: Partial<WebhookOptions>;
  mcp?: McpRegistry;
  promptDir?: string;
  context?: ContextConfig;
  retention?: Retention;
  gatewayAllowedHosts?: string[];
}

export interface App {
  logger: Logger;
  sessions: SessionStore;
  taskStore: TaskStore;
  manager: TaskManager;
  webhook: WebhookDispatcher;
  mcp: McpRegistry;
  retention: Retention;
  defaultModel: string;
  dirs: { home: string; logs: string; tasks: string; sessions: string };
  defaultWorkdir?: string;
  allowedRoots: string[];
  defaultWorkdirLock: boolean;
  /** Per-client limiter for the costing surfaces (named clients only). */
  rateLimiter: SlidingWindowLimiter;
}

const numEnv = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : undefined;
};

export function createApp(o: AppOptions): App {
  const env = process.env;
  const home = o.home ?? dataDir();
  const dirs = {
    home,
    logs: o.logDir ?? env.WRONGFORGE_LOG_DIR ?? path.join(home, "logs"),
    tasks: path.join(home, "tasks"),
    sessions: path.join(home, "sessions"),
  };
  // remember across restarts which models the API refuses `effort` for
  initEffortPersistence(path.join(home, "effort-rejections.json"));

  const level = (["debug", "info", "warn", "error"] as const).includes(env.WRONGFORGE_LOG_LEVEL as LogLevel)
    ? (env.WRONGFORGE_LOG_LEVEL as LogLevel)
    : "info";
  const logger = new Logger({
    dir: dirs.logs,
    level,
    stderr: /^(1|true|yes)$/i.test(env.WRONGFORGE_LOG_STDERR ?? ""),
    maxFileBytes: (numEnv(env.WRONGFORGE_LOG_MAX_MB) ?? 50) * 1024 * 1024,
  });

  const sessions = new SessionStore(dirs.sessions);
  const taskStore = new TaskStore(dirs.tasks);
  const mcp = o.mcp ?? defaultMcpRegistry(logger);

  const webhook = new WebhookDispatcher({
    key: env.WRONGFORGE_WEBHOOK_SECRET || o.apiKey,
    logger,
    maxAttempts: numEnv(env.WRONGFORGE_WEBHOOK_MAX_ATTEMPTS),
    ...o.webhook,
  });

  const defaultModel = o.defaultModel ?? (env.CLAUDE_MODEL || DEFAULT_MODEL);
  const defaultWorkdir = o.defaultWorkdir ?? (env.WRONGFORGE_WORKDIR || undefined);
  const allowedRoots =
    o.allowedRoots ?? (env.WRONGFORGE_ALLOWED_ROOTS ? env.WRONGFORGE_ALLOWED_ROOTS.split(path.delimiter).filter(Boolean) : []);
  const defaultWorkdirLock = o.defaultWorkdirLock ?? /^(1|true|yes)$/i.test(env.WRONGFORGE_WORKDIR_LOCK ?? "");

  const envConcurrency = numEnv(env.WRONGFORGE_MAX_CONCURRENCY);
  if (envConcurrency !== undefined && (!Number.isInteger(envConcurrency) || envConcurrency < 1)) {
    logger.warn("config.max_concurrency_invalid", { value: envConcurrency, used: Math.max(1, Math.floor(envConcurrency)) });
  }

  const managerOpts: ManagerOptions = {
    store: taskStore,
    sessions,
    client: createClaudeClient(o.oauth),
    logger,
    webhook,
    defaultModel,
    defaultWorkdir,
    allowedRoots,
    defaultWorkdirLock,
    maxConcurrency: o.maxConcurrency ?? Math.max(1, Math.floor(envConcurrency ?? 2)),
    // Queue-flood guard for named client keys (issue-#7 family): how many
    // QUEUED tasks one client may hold before further submits get 429
    // queue_full. 0 = unlimited; the default/admin key is never capped.
    maxQueuedPerClient: o.maxQueuedPerClient ?? (numEnv(env.WRONGFORGE_MAX_QUEUED_PER_CLIENT) ?? 50),
    heartbeatMs: o.heartbeatMs ?? numEnv(env.WRONGFORGE_HEARTBEAT_MS),
    defaultTimeoutMs: o.defaultTimeoutMs ?? numEnv(env.WRONGFORGE_TASK_TIMEOUT_MS),
    textFlushMs: o.textFlushMs,
    progressSaveMs: o.progressSaveMs,
    promptDir: o.promptDir,
    context: o.context,
    gatewayAllowedHosts: o.gatewayAllowedHosts,
    mcp,
  };
  const manager = new TaskManager(managerOpts);

  // Per-client rate limit for the COSTING surfaces (POST /v1/tasks and the
  // proxy /v1/messages*): requests per minute for named client keys. Default
  // 120 — generous next to how agents naturally call (seconds per request) —
  // 0 disables, and the default/admin key is never limited.
  const clientRateLimit = o.clientRateLimit ?? (numEnv(env.WRONGFORGE_CLIENT_RATE_LIMIT) ?? 120);

  return {
    logger, sessions, taskStore, manager, webhook, mcp,
    retention: o.retention ?? retentionFromEnv(),
    defaultModel, dirs, defaultWorkdir, allowedRoots, defaultWorkdirLock,
    rateLimiter: new SlidingWindowLimiter(Math.max(0, Math.floor(clientRateLimit))),
  };
}
