# Task API (protocol reference)

The contract between an orchestrator (WrongStack) and WrongForge. The source
of truth is the code: `src/server.ts` (routes), `src/tasks/types.ts` (types),
`src/tasks/manager.ts` (validation and lifecycle). This document describes what
they do; if they disagree, the code wins — and this file should be fixed.

- [Start & authenticate](#start--authenticate)
- [Concepts](#concepts)
- [`POST /v1/tasks`](#post-v1tasks) — submit
- [Task document](#task-document) · [Lifecycle](#lifecycle) · [Errors](#error-codes)
- [Events](#events) — [JSON / long-poll](#get-v1tasksidevents) · [SSE](#server-sent-events) · [global feed](#get-v1events)
- [Webhooks](#webhooks)
- [Other task endpoints](#other-task-endpoints)
- [Sessions](#sessions) · [Info, tools, usage, maintenance, health](#other-endpoints)
- [HTTP errors](#http-errors)

See also: [INTEGRATION.md](INTEGRATION.md) (how to build a client),
[TOOL-GATEWAY.md](TOOL-GATEWAY.md), [MCP.md](MCP.md).

## Start & authenticate

```bash
npm run import          # once (or `npm run login`) — the server needs a signed-in session
npm run serve           # http://127.0.0.1:8787  (PORT / HOST override)
```

Every route except `GET /health` needs `Authorization: Bearer <key>`
(compared in constant time); `?key=` on the URL is accepted as an alternative
for browser clients that cannot set headers (EventSource) — the query string
is never logged. The key is resolved at startup:

1. `AGENT_API_KEY` (must be ≥ 16 chars, otherwise the server refuses to start);
2. else the saved key in `<data dir>/api-key`;
3. else a strong key (`wf_…`) is generated, saved there (mode 0600) and shown in
   the startup banner.

### Multiple clients (several orchestrators, one server)

When more than one orchestrator (e.g. several WrongStack instances) shares one
WrongForge, give each its own **client key** so their work never mixes:

- `AGENT_API_KEYS="stackA=wf_…,stackB=wf_…"` (env), or
  `<data dir>/api-keys.json` (`{ "stackA": "wf_…" }`). The single key above
  stays valid and is the client **`default`**.
- Every task is stamped with the authenticated client (`task.client`); the
  field is server-assigned — a body value is ignored.
- **Sessions are owned by their creator.** A client submitting to another
  client's session gets `403 session_not_owned` — histories can never merge
  across orchestrators. Sessions that predate client keys belong to `default`.
- `GET /v1/tasks`, `GET /v1/events` (the global feed), and the sessions routes
  are scoped to the caller; a foreign task answers `404 task_not_found` (no
  existence leak) and a foreign session `403 session_not_owned`.
- `default` is the admin view: it sees every client (the dashboard connects
  with it). Resubmitting another client's `task_id` conflicts with
  `409 task_id_conflict` without echoing the task.
- Client names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,31}` (never
  `default`), keys ≥ 16 chars; invalid configuration refuses to start.
- The queue is fair across clients: a client that already holds
  `max_concurrency - 1` slots cannot take the last one while another client
  has a startable task queued (never applies with `max_concurrency` 1).
- The Anthropic-compatible proxy surface (`/v1/messages`, `/v1/models`) is
  **shared**: every client key may call it, and proxy calls are not
  attributed to clients (they are not tasks).

The server also serves a built dashboard (React + Radix UI + React Flow) at
`/` when `webui/dist` exists (`npm run webui:build`): live firehose, task
detail with per-step request/response traffic, sessions, and a graph view of
the running system. The shell itself is public; every piece of data still
requires the key.

A missing or wrong key → `401 unauthorized`. Request bodies are capped at
1 000 000 bytes (`413 body_too_large`).

## Concepts

| Term | Meaning |
|---|---|
| **task** | One unit of work: a prompt the agent carries out. Asynchronous; has a status, progress, a result or an error, and an ordered event log. |
| **session** | The model's conversation memory. A task naming a `session_id` continues that conversation (also after a server restart); without one a new session is created. One session runs one task at a time. |
| **workdir** | The directory a task starts in (relative paths and shell commands). **Not a sandbox.** |
| **event** | A numbered record of something that happened in a task. `seq` starts at 1 per task and is strictly increasing and gap-free. Events are stored (`events.jsonl`) so they can be replayed. |

## `POST /v1/tasks`

Submits a task. Body (JSON object):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `prompt` | string | **required** | The instruction. Non-empty, ≤ 200 000 chars. |
| `task_id` | string | generated `tsk_…` | Your own id = **idempotency key**. `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`. |
| `session_id` | string | new `ses_…` | Continue this session; created if it does not exist. Same id pattern as `task_id`. |
| `model` | string | server default (`CLAUDE_MODEL`, `claude-sonnet-5-5`) | `[A-Za-z0-9][A-Za-z0-9._:-]{0,99}`. |
| `max_steps` | integer | `50` | Model round-trips allowed, 1–500. |
| `timeout_ms` | integer | `1 800 000` (30 min; `WRONGFORGE_TASK_TIMEOUT_MS`) | Wall-clock limit, 1000–14 400 000 (4 h). |
| `workdir` | string | server default | Directory to run in; absolute, or relative to the server's default workdir. **Required** when the server has no default (`WRONGFORGE_WORKDIR`). Must exist; symlinks are resolved; checked against `WRONGFORGE_ALLOWED_ROOTS`. |
| `workdir_lock` | boolean | `WRONGFORGE_WORKDIR_LOCK` or `false` | Exclusive use of the workdir (see [Concurrency](#concurrency)). |
| `cache` | `"5m"` \| `"1h"` \| `"off"` | `WRONGFORGE_CACHE` or `"1h"` | Prompt-cache lifetime for this task's requests. |
| `effort` | `"low"` \| `"medium"` \| `"high"` \| `"off"` | `WRONGFORGE_EFFORT` or `"high"` | Reasoning effort for this task's requests. Clamped to the levels the model supports; models without effort support never receive the field; `"off"` never sends it. When an organization's plan caps a model's effort (the API answers `Invalid effort level`), the server learns the working level per model (7 days) and clamps to it automatically instead of disabling effort. |
| `priority` | `"low"` \| `"normal"` | `"normal"` | Queue priority. Low-priority tasks keep the last concurrency slot free for normal tasks, so a fleet of helper tasks can never starve interactive work (with `max_concurrency` 1 a low-priority task effectively never starts). Submit fleet/helper tasks as `"low"` and keep interactive tasks `"normal"`. |
| `env` | object of strings | `{}` | Extra environment variables for the `bash` tool. ≤ 50 entries, names `[A-Za-z_][A-Za-z0-9_]{0,99}`, values ≤ 8192 chars. **Values are never persisted or logged** — only the names (`env_keys`). |
| `system_append` | string | – | Extra instructions appended to the system prompt, ≤ 20 000 chars. |
| `context` | any JSON | – | Opaque data echoed back untouched in the task document. |
| `callback` | `{ url, events? }` | – | Webhook target, see [Webhooks](#webhooks). `events`: ≤ 30 patterns. |
| `gateway` | object | – | Tools provided by the orchestrator, see [TOOL-GATEWAY.md](TOOL-GATEWAY.md). |
| `mcp` | string[] | default set | Which MCP servers expose typed tools for this task, see [MCP.md](MCP.md#choosing-servers-per-task). ≤ 50 names or `["*"]`. |

Submit-mode flags (consumed by the server, not stored):

| Flag | Effect |
|---|---|
| *(none)* | `202 Accepted` with `{ task, deduplicated }` and a `Location: /v1/tasks/<id>` header. |
| `wait: true` | The request stays open until the task is terminal, then `200 { task, deduplicated }`. |
| `stream: true` | `200` SSE stream of this task's events from `seq` 1 (see [SSE](#server-sent-events)). |
| `cancel_on_disconnect: true` | With `wait` or `stream`: cancel the task if the client disconnects. |

```bash
curl -N http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"run the tests and report what fails","workdir":"D:/work/app","stream":true}'
```

**Idempotency.** Re-sending an existing `task_id` returns that task with
`deduplicated: true` (status `200` instead of `202`) and does not run it again.
If the prompt or `session_id` differs → `409 task_id_conflict`. Use it to make
retries after network errors safe.

**Validation errors** are `400` with the codes in the table below (plus
`503 shutting_down` while the server stops, `503 not_signed_in` if no session).

## Task document

Returned by `POST /v1/tasks`, `GET /v1/tasks/:id` and the list endpoint.
Persisted as `tasks/<id>/task.json`.

```jsonc
{
  "id": "tsk_1a2b3c4d5e6f7a8b",
  "status": "running",                 // queued | running | completed | failed | cancelled | timed_out
  "session_id": "ses_…",
  "session_created": true,             // this task created the session
  "prompt": "…",
  "model": "claude-sonnet-5-5",
  "max_steps": 50,
  "timeout_ms": 1800000,
  "workdir": "D:\\work\\app",          // canonical absolute path
  "workdir_lock": false,
  "cache": "1h",
  "effort": "high",                    // low | medium | high | off
  "client": "stackA",                  // authenticated client key; absent = the default key
  "env_keys": ["API_URL"],             // names only
  "system_append": "…",                // if given
  "context": { },                      // if given, untouched
  "callback": { "url": "…", "events": ["task.*"] },
  "callback_stats": { "delivered": 12, "failed": 0, "last_error": "…" },
  "gateway": { /* secret-free view, see TOOL-GATEWAY.md */ },
  "mcp": ["github"],                   // if given
  "created_at": "2026-10-15T12:00:00.000Z",
  "started_at": "…", "finished_at": "…",
  "progress": {
    "last_event_seq": 42, "steps": 3, "tool_calls": 7,
    "current_tool": { "id": "toolu_…", "name": "bash", "started_at": "…" },
    "last_report": { "message": "tests running", "percent": 40, "phase": "verifying", "at": "…" },
    "todos": [ /* current todo list */ ],
    "last_activity_at": "…"
  },
  "result": {                          // completed (and max_steps / max_tokens failures)
    "text": "final assistant text",
    "finish_reason": "end_turn",       // end_turn | stop_sequence | tool_use | max_tokens
    "steps": 3, "tool_calls": 7,
    "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "cache_read_tokens": 0, "cache_write_tokens": 0 },
    "context_tokens": 18500, "context_window": 1000000, "context_percent": 1.9,
    "duration_ms": 41230
  },
  "error": { "code": "max_steps", "message": "…" },   // failed
  "cancel_reason": "…"                                // cancelled
}
```

`progress` is saved with a short debounce (about 2 s), so the persisted file can
lag the live state slightly; the event log is always exact.
`result.text` is the **final message of the task** — what the orchestrator
should treat as the answer.

## Lifecycle

```
queued ──▶ running ──▶ completed
   │          ├──────▶ failed        (error.code, see below)
   │          ├──────▶ cancelled     (POST …/cancel, or client disconnect with cancel_on_disconnect)
   │          └──────▶ timed_out     (timeout_ms elapsed)
   └─────────────────▶ cancelled / failed(server_restarted)
```

`completed`, `failed`, `cancelled`, `timed_out` are terminal. While running, the
server emits `task.heartbeat` every 15 s (`WRONGFORGE_HEARTBEAT_MS`) so a silent
task is distinguishable from a dead server.

How a turn ends (`result.finish_reason` → status):

| Model stop reason | Status | Error code |
|---|---|---|
| `end_turn`, `stop_sequence` | `completed` | – |
| `tool_use` (step budget ran out while the model still wanted tools) | `failed` | `max_steps` |
| `max_tokens` | `failed` | `max_tokens` |
| anything else / provider failure | `failed` | `agent_error` |

For `max_steps` and `max_tokens` the work done so far **is kept** in the session:
send a follow-up task with the same `session_id` to continue.

### Error codes

`task.error.code` (a failed task):

| Code | Meaning |
|---|---|
| `agent_error` | The model/provider call or the loop failed; `message` carries the API's words. |
| `max_steps` | Step limit reached before the model finished. |
| `max_tokens` | The model hit its output limit. |
| `context_overflow` | The conversation does not fit the context window, even after one automatic compaction retry. The session is flagged for compaction — re-send with the same `session_id`, or start a new session. |
| `tool_gateway_unavailable` | The orchestrator's tool API could not be reached for discovery (and `gateway.optional` was not set). |
| `mcp_unavailable` | A `required` MCP server selected for the task could not be reached. |
| `server_restarted` | The server stopped (or restarted) while the task was queued or running. Re-send it. |
| `internal_error` | A bug or an unexpected exception (e.g. the session could not be saved). |

Submit-time errors (HTTP `400` unless noted), `error.code` in the response body:
`invalid_request`, `workdir_required`, `invalid_workdir`, `workdir_not_allowed`
(403), `invalid_gateway`, `unknown_mcp_server`, `callbacks_disabled`,
`task_id_conflict` (409), `shutting_down` (503), `not_signed_in` (503).

## Concurrency

- At most `WRONGFORGE_MAX_CONCURRENCY` tasks run at once (default 2); the rest
  wait in a FIFO queue.
- A session runs one task at a time. Later tasks of a busy session wait and keep
  their order.
- `workdir_lock: true` — the task waits until no other task runs in that
  directory, and blocks others meanwhile. Without locks, tasks in the same
  directory may run in parallel (and may step on each other's files). A waiting
  locked task also holds back later tasks of the same directory (no starvation).
- `task.queued` says why a task cannot start yet: `data.waiting_for` is
  `"capacity"`, `"session"`, `"workdir"` or `null` (starts immediately).
- Low-priority tasks (`priority: "low"`) additionally keep the last slot free
  for normal tasks: they may start only while fewer than
  `max_concurrency - 1` tasks run. Submit orchestrator helper/fleet tasks as
  `"low"` so a burst of them can never occupy every slot and starve the
  interactive task that spawned them.
- The last slot is also shared **across clients**: a client that already holds
  `max_concurrency - 1` slots cannot take the final one while another client
  has a startable task queued, so two orchestrators interleave instead of one
  hogging every slot (never applies with `max_concurrency` 1, and never for
  `priority: "low"` tasks, whose reservation is stricter).
- A queued task's wait is observable without polling: every time its position
  or block reason changes it emits `task.queue_update`, and
  `GET /v1/tasks/:id` reports `queue_position` and `waiting_for` alongside the
  task document while status is `"queued"`.
- There is **no server-side queue timeout**: a queued task waits until a slot
  frees or it is cancelled. If your client enforces its own wait deadline
  (e.g. an HTTP timeout that turns the wait into a 408), either raise it,
  cancel the task, or submit the burst of helpers as `priority: "low"`.

Queue state is visible in `GET /health` (`queued`, `running`) and `GET /v1/info`.

## Events

```jsonc
{ "seq": 7, "ts": "2026-10-15T12:00:03.120Z", "task_id": "tsk_…", "session_id": "ses_…",
  "type": "tool.started", "data": { /* depends on type */ } }
```

| Type | `data` (main fields) |
|---|---|
| `task.queued` | `position`, `waiting_for`, `session_id`, `session_created`, `workdir` |
| `task.queue_update` | `position`, `waiting_for`, `priority` — emitted whenever a still-queued task's position or block reason changes (queue shifts, capacity frees up) |
| `task.started` | `model`, `workdir`, `session_id`, `session_created`, `resumed_messages`, `context_tokens`, `cache`, `effort`, `max_steps`, `timeout_ms`, and `session_workdir_changed_from` when the session last worked in another directory |
| `task.heartbeat` | `elapsed_ms`, `steps`, `tool_calls`, `current_tool`, `last_activity_at` |
| `task.completed` | `result` |
| `task.failed` | `error`, and `result` if there is one |
| `task.cancelled` | `reason` |
| `task.timed_out` | `timeout_ms` |
| `step.started` | `step` |
| `step.request` | `step`, `model`, `effort` (resolved, null when omitted), `max_tokens`, `messages`, `tools` — what this step sends to the model |
| `step.finished` | `step`, `finish_reason`, `usage`, `context_tokens` |
| `tools.loaded` | `source` (`discovery` \| `inline` \| `mcp`), `count`, `tools`, `hash`, `warnings`, plus `url`/`cached`/`error` (gateway) or `servers` (MCP); gateway loads also carry `shadowed` — the built-ins hidden because the orchestrator provides a `<prefix><name>` twin |
| `session.compacting` | `reason` (`threshold` \| `flagged_after_overflow` \| `context_overflow`), `context_tokens`, `threshold`, `messages`, `keep_turns` |
| `session.compacted` | `compacted`, `messages_before`, `messages_after`, `turns_summarized`, `turns_kept`, `summary_chars`, `archive` |
| `context.cleared` | `cleared`, `context_tokens` — old tool outputs replaced by a placeholder |
| `agent.text` | `text` — model text, coalesced (flushed about every 300 ms, or at 4000 chars, or at step/tool boundaries) |
| `agent.report` | `message`, `percent?`, `phase?` — from the agent's `report_progress` tool |
| `agent.todos` | `todos` — after each successful `todo_write` |
| `tool.started` | `tool_call_id`, `name`, `input`, `external: true` for gateway/MCP tools |
| `tool.finished` | `tool_call_id`, `name`, `output`, `ok?`, `external?` |
| `tool.failed` | `tool_call_id`, `name`, `error` |

`report_progress` calls surface only as `agent.report`, not as `tool.*`.
Terminal events (`task.completed/failed/cancelled/timed_out`) are always the
last event of a task.

### `GET /v1/tasks/:id/events`

Three ways to read, same data:

**JSON page / long-poll** (default):

| Query | Meaning |
|---|---|
| `after` | Only events with `seq` > this (default 0). `Last-Event-ID` is honoured as a fallback. |
| `limit` | 1–5000 (default 1000). |
| `wait_ms` | 0–30 000. If there are no new events and the task is not terminal, hold the request up to this long. |

```json
{ "task_id": "tsk_…", "status": "running", "terminal": false,
  "events": [ { "seq": 8, "…": "…" } ], "next_after": 8 }
```

Poll loop: call with `after=<next_after>&wait_ms=25000` until `terminal` is
`true` and no events are returned.

**SSE**: send `Accept: text/event-stream` or `?stream=1`.

### Server-Sent Events

```
: connected

id: 7
event: tool.started
data: {"seq":7,"ts":"…","task_id":"…","session_id":"…","type":"tool.started","data":{…}}

: ping

event: end
data: {"task_id":"tsk_…","status":"completed"}
```

- The SSE `event:` is the event type, `id:` is the `seq`; `data:` is the whole
  event object. Reconnect with `Last-Event-ID: <last seq>` (or `?after=`) to
  resume without gaps or duplicates.
- A `: ping` comment is sent every 15 s.
- The stream replays stored events first, then continues live, and ends with a
  final `event: end` once the task is terminal.
- A closed connection only stops the stream — the task keeps running (unless
  submitted with `cancel_on_disconnect`).

### `GET /v1/events`

Live SSE feed of every task **the caller can see** — the `default` key sees
all clients, a named client key only its own tasks (`http.request` /
`proxy.call` traffic frames carry no task attribution and are dropped for
named clients). `?task_id=` and `?session_id=` filter it further. Events
have no `id:`. Use it for dashboards. On connect the feed first replays its
backlog — the last ≤300 `http.request` frames (in-memory) and the newest ≤300
task events read from disk (heartbeats skipped; survives serve restarts) —
then continues live. `http.request` frames are fire-and-forget traffic views
(`{ts, method, path, status, duration_ms}`), never part of the task protocol.

The feed also carries `http.request` frames — `{ type, ts, method, path,
status, duration_ms }` for every `/v1` call as it completes (the stream itself
excluded). They are fire-and-forget, never persisted, so the dashboard can show
incoming traffic even while no task is running.

It also carries `proxy.call` frames — one per call to the Anthropic-compatible
endpoint (`/v1/messages`, `/v1/messages/count_tokens`, `/v1/models`, see
README § Anthropic-compatible endpoint): `{ type, id, ts, method, path,
status, duration_ms, auth_mode, model?, stream?, request_body?,
request_truncated, response_body?, response_truncated }`. `request_body` and
`response_body` are size-capped copies for display (`WRONGFORGE_PROXY_TAP_BODY_CAP`,
default 8 KB) — truncation never affects what the real client exchanged, only
how much of it the dashboard's "Proxy" tab shows. Backlog ≤150 frames, same
fire-and-forget, never-persisted contract as `http.request`.

## Webhooks

With `callback: { "url": "https://…", "events": ["task.*", "tool.*"] }` the
server POSTs events to your URL.

- **Filter:** patterns are exact (`task.completed`), prefix wildcards
  (`task.*`) or `*`. Default (no `events`): `task.*`, `step.*`, `agent.report`,
  `agent.todos`, `tool.*` — everything except raw `agent.text`.
- **Body:** the event JSON; string fields inside `data` are cut to 4000 chars.
- **Headers:**

  | Header | Value |
  |---|---|
  | `X-WrongForge-Event` | event type |
  | `X-WrongForge-Task` | task id |
  | `X-WrongForge-Seq` | event seq |
  | `X-WrongForge-Delivery` | UUID, **stable across retries** of one event |
  | `X-WrongForge-Attempt` | 1, 2, … |
  | `X-WrongForge-Timestamp` | Unix seconds |
  | `X-WrongForge-Signature` | `sha256=<hex>` |
  | `User-Agent` | `WrongForge/<version>` |

- **Signature:** `HMAC-SHA256(key, "<timestamp>.<raw body>")`, hex, prefixed
  `sha256=`. The key is `WRONGFORGE_WEBHOOK_SECRET` if set, otherwise the API
  key. Verify with the **raw** body bytes and reject old timestamps.
- **Delivery semantics:** at-least-once. Events of one task are delivered
  strictly in order (a retrying event blocks the ones behind it); different
  tasks are delivered in parallel. Network errors, timeouts (10 s), HTTP 5xx,
  408 and 429 are retried with exponential backoff (1 s, 2 s, 4 s … capped at
  60 s) up to `WRONGFORGE_WEBHOOK_MAX_ATTEMPTS` (default 6). Other 4xx responses
  are **not** retried. Respond `2xx` quickly.
- **De-duplicate** with `X-WrongForge-Delivery`, or `(task_id, seq)`.
- Webhooks are best effort: a dead receiver never affects the task. Delivery
  counts are in `task.callback_stats`; missed events can always be fetched with
  `GET /v1/tasks/:id/events?after=<last seq you have>` (use `seq` to spot gaps).

Verifying (Node):

```js
import crypto from "node:crypto";
function verify(rawBody, headers, key) {
  const ts = headers["x-wrongforge-timestamp"];
  const expect = "sha256=" + crypto.createHmac("sha256", key).update(`${ts}.${rawBody}`).digest("hex");
  const got = headers["x-wrongforge-signature"] ?? "";
  return got.length === expect.length
      && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expect))
      && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
}
```

## Other task endpoints

### `GET /v1/tasks`

List, newest first. Query: `status` (comma list of the six statuses),
`session_id`, `before` (ISO `created_at` cursor), `limit` (1–500, default 50).
Response: `{ "tasks": [TaskRecord…], "next_before": "<created_at>" | null }` —
pass `next_before` as `before` for the next page (`null` = no more).

### `GET /v1/tasks/:id`

`{ "task": TaskRecord }`, or `404 task_not_found`. While the task is queued,
the response also carries `queue_position` (0-based) and `waiting_for`
(`"capacity"` / `"session"` / `"workdir"` / `null`) so a client can show why
the task is waiting without subscribing to the event stream.

### `POST /v1/tasks/:id/cancel`

Body (optional): `{ "reason": "…" }` (≤ 500 chars). A queued task is cancelled
immediately; a running one has its model call and shell commands aborted, and
the request returns when the task reached `cancelled` (or after 10 s).
Response `{ "task": TaskRecord, "already_finished": boolean }`. Cancelling a
finished task is harmless (`already_finished: true`). A cancelled task does not
add its half-done turn to the session.

## Sessions

A session stores the conversation under `<data dir>/sessions/<id>/`.
Messages are appended only after a turn **succeeded** (or ended with
`max_steps` / `max_tokens`), so a failed or cancelled task never leaves a half
turn behind.

| Endpoint | Meaning |
|---|---|
| `GET /v1/sessions` | `{ "sessions": [SessionMeta…] }`, most recently updated first |
| `POST /v1/sessions` | Create. Body `{ "id"? }` → `201 { session }`; `409 session_exists` |
| `GET /v1/sessions/:id` | `{ session, in_use }` — `in_use`: a task is queued/running in it |
| `DELETE /v1/sessions/:id` | `{ "deleted": id }`; `409 session_busy` while in use |
| `GET /v1/sessions/:id/messages` | `?offset=&limit=` (1–1000, default 100) → `{ session_id, total, messages }` |
| `POST /v1/sessions/:id/compact` | Summarize old turns now. Body `{ "model"? }` → `{ compacted, messages_before, messages_after, turns_summarized, archive?, meta }`. `409 session_busy` while in use |

`SessionMeta`: `id`, `created_at`, `updated_at`, `turns`, `message_count`,
`title` (first prompt, truncated), `model`, `workdir` (of the last turn),
`context_tokens` (size after the last turn), `compactions`,
`last_compaction_at`, `needs_compaction`, `last_task_id`, `task_ids` (recent),
`owner` (creating client; absent = the default key / pre-clients sessions).
Named client keys see and touch only their own sessions here — a foreign
session answers `403 session_not_owned` (GET/DELETE/messages/compact).

**Compaction.** A session's whole history is sent with every request. Before a
task starts, if the session's `context_tokens` ≥ `WRONGFORGE_COMPACT_AT`
(default 150 000) — or it was flagged after an overflow — older turns are
summarized by the model into one message (the last `WRONGFORGE_COMPACT_KEEP_TURNS`
turns, default 2, stay verbatim; originals are archived). Inside a running task,
once the live context passes `WRONGFORGE_CLEAR_AT` (default 600 000), old tool
outputs are replaced with `[tool output cleared to save context]`. Both change
the cached prefix once; see [prompt caching](../README.md#sessions--context-management).

**Working directory changes.** If a session continues in a different `workdir`,
`task.started` carries `session_workdir_changed_from` — paths mentioned in the
old history may no longer apply.

## Other endpoints

| Endpoint | Meaning |
|---|---|
| `GET /health` | **No auth.** `{ ok, name, version, signed_in, queued, running }` |
| `GET /v1/info` | Capabilities and effective settings: `name`, `version`, `protocol` (1), `signed_in`, `default_model`, `models` (ids), `model_details` (per model: `id`, `description`, `effort_levels` — empty when the model has no effort support), `queue` (`queued`, `running`, `max_concurrency`), `workdir` (`default`, `required`, `allowed_roots`, `lock_by_default`), `context`, `cache`, `effort` (`default`, `levels`), `limits` (`max_body_bytes`, `max_steps`, `default_max_steps`), `webhook` (signature scheme, which key), `tools`, `tool_guides`, `mcp` (config file, server count), `dirs` |
| `GET /v1/tools` | `{ "tools": [{ name, description }] }` — the built-in tools |
| `GET /v1/usage` | Plan usage of the signed-in subscription (`five_hour`, `weekly`, `extra_usage`), cached 5 min; `?force=1` bypasses the cache; `502 usage_unavailable` if it cannot be read |
| `POST /v1/maintenance/run` | Run housekeeping now (log/task compression and retention, session pruning). Live tasks and busy sessions are never touched |
| `/v1/mcp/…` | MCP server management, see [MCP.md](MCP.md#http-management) |

Usage example:

```json
{
  "five_hour":   { "percent": 41, "resetsAt": "2026-10-15T17:29:59Z", "isActive": true },
  "weekly":      { "percent": 0,  "resetsAt": "2026-10-16T17:00:00Z", "isActive": false },
  "extra_usage": { "enabled": false, "usedCredits": null, "monthlyLimit": null, "utilization": null }
}
```

## HTTP errors

Errors have the shape `{ "error": { "code": "…", "message": "…" } }`.

| Status | Codes |
|---|---|
| 400 | `invalid_json`, `invalid_request`, `workdir_required`, `invalid_workdir`, `invalid_gateway`, `unknown_mcp_server`, `callbacks_disabled`, `invalid_mcp_config` |
| 401 | `unauthorized` (`WWW-Authenticate: Bearer`) |
| 403 | `workdir_not_allowed`, `session_not_owned` (a client submitting to another client's session) |
| 404 | `not_found`, `task_not_found`, `session_not_found`, `no_such_session`, `mcp_server_not_found`, `mcp_tool_not_found`, `unknown_server` (MCP) |
| 409 | `task_id_conflict`, `session_exists`, `session_busy`, `server_disabled` (MCP) |
| 413 | `body_too_large` |
| 500 | `internal_error` |
| 502 | `usage_unavailable`, `compaction_failed`, MCP connection errors (`mcp_unavailable`, `mcp_error`) |
| 503 | `not_signed_in`, `shutting_down` |

## Limits at a glance

| What | Limit |
|---|---|
| request body | 1 000 000 bytes |
| `prompt` | 200 000 chars |
| `max_steps` | 1–500 (default 50) |
| `timeout_ms` | 1000–14 400 000 (default 30 min) |
| `env` | 50 variables, values ≤ 8192 chars |
| `system_append` | 20 000 chars |
| `callback.events` | 30 patterns |
| `mcp` | 50 names |
| events page | `limit` ≤ 5000, `wait_ms` ≤ 30 000 |
| task list page | `limit` ≤ 500 |

## Persistence & restarts

Tasks live in `<data dir>/tasks/<id>/` (`task.json` + `events.jsonl`); finished
tasks' event logs are gzip-compressed after `WRONGFORGE_TASK_COMPRESS_AFTER_DAYS`
(3) and removed after `WRONGFORGE_TASK_RETENTION_DAYS` (90). On startup, tasks
left `queued`/`running` by a previous run are finished as `failed` with
`server_restarted` (and their webhook fires). On Ctrl+C / SIGTERM the server
stops accepting tasks, interrupts running ones (`server_restarted`), flushes
webhook deliveries (up to 10 s) and closes MCP connections.
