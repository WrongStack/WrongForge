/**
 * Task protocol types — the contract between an orchestrator (WrongStack)
 * and WrongForge. Keep docs/TASKS-API.md in sync with this file.
 */

import type { TokenUsage } from "../agent.js";
import type { Todo } from "../tools/todo-state.js";
import type { CacheMode } from "../cache.js";
import type { EffortSetting } from "../effort.js";
import type { GatewayInfo, GatewaySpec } from "../tools/gateway.js";

/** `queued` and `running` are live; the other four are terminal. */
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "timed_out";

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);

export const isTerminal = (s: TaskStatus): boolean => TERMINAL_STATUSES.has(s);

/** Machine-readable failure reasons (`error.code`). */
export type TaskErrorCode =
  | "agent_error" //       the model/provider call or the loop failed
  | "max_steps" //         step limit reached before the model finished
  | "max_tokens" //        output limit hit (finish_reason "length")
  | "context_overflow" //  the conversation does not fit the model's context window
  | "cache_ordering_error" // the session's cache_control TTLs are ordered inconsistently (mixed cache modes across turns); fixed by compaction, same as context_overflow
  | "tool_gateway_unavailable" // the orchestrator's tool API could not be reached for discovery
  | "mcp_unavailable" //   a `required` MCP server selected for the task could not be reached
  | "server_restarted" //  the server stopped while the task was queued/running
  | "internal_error"; //   bug / unexpected exception

export interface TaskError {
  code: TaskErrorCode;
  message: string;
}

export interface TaskResult {
  /** Final assistant text (all steps concatenated). */
  text: string;
  /** AI SDK finish reason: stop | length | tool-calls | … */
  finish_reason: string;
  steps: number;
  tool_calls: number;
  usage: TokenUsage;
  /** Conversation size after this task, in tokens (what the next task starts from). */
  context_tokens: number;
  context_window: number;
  /** context_tokens / context_window, 0-100. */
  context_percent: number;
  duration_ms: number;
}

export interface TaskProgress {
  /** Highest event seq written so far. */
  last_event_seq: number;
  steps: number;
  tool_calls: number;
  /** Tool currently executing, if any. */
  current_tool?: { id: string; name: string; started_at: string };
  /** Last `report_progress` message. */
  last_report?: { message: string; percent?: number; phase?: string; at: string };
  /** Current todo list. */
  todos?: Todo[];
  /** Last time anything happened (event or heartbeat-free activity). */
  last_activity_at: string;
}

export interface CallbackSpec {
  /** Where WrongForge POSTs events. */
  url: string;
  /**
   * Which event types to send. Patterns: exact (`task.completed`), prefix
   * wildcard (`task.*`, `tool.*`) or `*`. Default: everything except `agent.text`.
   */
  events?: string[];
}

export interface CallbackStats {
  delivered: number;
  failed: number;
  last_error?: string;
}

/** The persisted + API-visible task document (`tasks/<id>/task.json`). */
export interface TaskRecord {
  id: string;
  status: TaskStatus;
  session_id: string;
  /** True when this task created the session. */
  session_created: boolean;
  prompt: string;
  model: string;
  max_steps: number;
  timeout_ms: number;
  /** Absolute working directory the task runs in. */
  workdir: string;
  /** True: no other task may run in this workdir at the same time. */
  workdir_lock: boolean;
  /** Prompt-cache mode used for this task's requests. */
  cache: CacheMode;
  /**
   * Reasoning effort used for this task's requests ("off" = the field is not
   * sent). Absent only on records persisted before the field existed.
   */
  effort?: EffortSetting;
  /**
   * Queue priority. Only "low" is recorded; an absent field means "normal".
   * Low-priority tasks keep the last concurrency slot free for normal tasks
   * (issue #7: helper tasks filling every slot starved the leader's next
   * model call until the client timed out) — see manager.ts's blockReason.
   */
  priority?: "low";
  /**
   * Client (API key identity) that submitted this task. Absent = the single
   * "default" key. Task list/event/cancel routes are scoped to it; sessions
   * are owned by their creator, so two orchestrators never share history.
   */
  client?: string;
  /**
   * Image attachment metadata refs — the decoded bytes live as files in the
   * task dir (`images/NN.<ext>`), re-read at request time. Written by
   * submit from the request's `images` (see src/images.ts).
   */
  images?: Array<{ file: string; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; bytes: number }>;
  /** Names only — values are never persisted. */
  env_keys: string[];
  system_append?: string;
  /** Opaque JSON from the caller, echoed back untouched. */
  context?: unknown;
  callback?: CallbackSpec;
  callback_stats?: CallbackStats;
  /** Orchestrator-provided tools (secret-free view; token/headers are memory only). */
  gateway?: GatewayInfo;
  /** MCP servers selected for this task (absent = the default set: every enabled, eager server). */
  mcp?: string[];
  /** Built-in tools this task may use (absent = all of them). */
  builtin_tools?: string[];

  created_at: string;
  started_at?: string;
  finished_at?: string;

  progress: TaskProgress;
  result?: TaskResult;
  error?: TaskError;
  /** Why it was cancelled (cancel reason), if cancelled. */
  cancel_reason?: string;
}

export type TaskEventType =
  | "task.queued"
  | "task.queue_update"
  | "task.started"
  | "task.heartbeat"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.timed_out"
  | "step.started"
  | "step.request"
  | "step.finished"
  | "tools.loaded"
  | "session.compacting"
  | "session.compacted"
  | "session.cache_mode_locked"
  | "context.cleared"
  | "agent.text"
  | "agent.report"
  | "agent.todos"
  | "tool.started"
  | "tool.finished"
  | "tool.failed";

/** One line of `events.jsonl`, one SSE event, one webhook body. */
export interface TaskEvent {
  /** Per-task, starts at 1, strictly increasing, gap-free. */
  seq: number;
  ts: string;
  task_id: string;
  session_id: string;
  type: TaskEventType;
  data: Record<string, unknown>;
}

/** Body of `POST /v1/tasks`. */
export interface SubmitRequest {
  prompt: string;
  /** Client-chosen id = idempotency key. Generated if omitted. */
  task_id?: string;
  /** Continue this session; created if it does not exist. New session if omitted. */
  session_id?: string;
  model?: string;
  max_steps?: number;
  timeout_ms?: number;
  /**
   * Directory the task works in (absolute, or relative to the server's default
   * workdir). Required unless the server has a default workdir configured.
   * This is where relative paths and shell commands start — it is NOT a sandbox.
   */
  workdir?: string;
  /** Exclusive use of the workdir: wait until no other task runs there, block others meanwhile. */
  workdir_lock?: boolean;
  /** Prompt cache: "5m" | "1h" | "off" (default: server setting, "1h"). */
  cache?: CacheMode;
  /**
   * Reasoning effort: "low" | "medium" | "high" | "off" (default: server
   * setting, "high"). Clamped to the levels the model supports; models with
   * no effort support never receive the field.
   */
  effort?: EffortSetting;
  /**
   * Queue priority: "low" | "normal" (default "normal"). Low-priority tasks
   * keep the last concurrency slot free for normal tasks, so a fleet of
   * helper tasks can never starve interactive work (issue #7). With
   * max_concurrency 1 a low-priority task effectively never starts.
   */
  priority?: "low" | "normal";
  /**
   * Image attachments, base64: `{ media_type: "image/png"|"image/jpeg"|
   * "image/gif"|"image/webp", data: "<base64>" }`. Limits: ≤ 5 MB decoded
   * per image, ≤ 5 images (src/images.ts; magic bytes must match). The
   * decoded bytes are stored as files in the task dir; the first user
   * message carries them as inline image blocks the model can see.
   */
  images?: Array<{ media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string }>;
  env?: Record<string, string>;
  system_append?: string;
  context?: unknown;
  callback?: CallbackSpec;
  /**
   * Tools provided by the orchestrator over HTTP: discovered (GET list) or
   * given inline, executed by POSTing each call back. See docs/TOOL-GATEWAY.md.
   */
  gateway?: GatewaySpec;
  /**
   * Which configured MCP servers get their tools exposed individually for this
   * task. Omit = every enabled server that is `eager`; ["*"] = every enabled
   * server; ["github","db"] = exactly these; [] = none (the agent can still use
   * `mcp_tools` / `mcp_call`). See docs/MCP.md.
   */
  mcp?: string[];
  /**
   * Allowlist of WrongForge's OWN tools for this task (names from GET /v1/tools).
   * Omit = all of them. Gateway (`wstack_*`) and MCP tools are not affected, so
   * an orchestrator can route writes and shell through its own tools:
   * e.g. ["read","ls","glob","grep","todo_read","todo_write","report_progress"].
   */
  builtin_tools?: string[];
}
