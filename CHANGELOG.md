# Changelog

Notable changes to WrongForge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match
package.json and the git tags that drive the release workflow.

## [Unreleased]

### Added
- **Named client keys: several orchestrators can share one WrongForge server
  without their work mixing.** `AGENT_API_KEYS="stackA=wf_…,stackB=wf_…"`
  (or `<data dir>/api-keys.json`) gives each WrongStack instance its own
  credential. Tasks are stamped with the authenticated client
  (`task.client`, server-assigned), **sessions are owned by their creator** —
  a client submitting to another client's session is refused
  (`403 session_not_owned`), so conversation histories can never merge —
  and `GET /v1/tasks`, the `/v1/events` global feed and the sessions routes
  are scoped to the caller (foreign tasks answer `404`, no existence leak).
  The single key stays valid as the `default` admin view (sees every
  client), so single-orchestrator setups are untouched.
- **The task queue is fair across clients:** a client that already holds
  `max_concurrency - 1` slots cannot take the last one while another client
  has a startable task queued — two orchestrators interleave instead of one
  hogging every slot (never applies with `max_concurrency` 1; the
  `priority: "low"` reservation from 0.4.16 composes on top).
- **Upstream model-call retries are now visible while a task runs.** When the
  API answers a retryable status (408/409/429/5xx), the task emits an
  `agent.report` event (`phase: "retry"`) saying the status, the server's
  `retry-after` if any, and how many client retries remain — the SDK's own
  retries were silent, so a busy backend could leave a RUNNING task without a
  single event for minutes (the non-queue half of #7's incident).
- **`WRONGFORGE_MAX_RETRIES` makes the client-retry budget configurable**
  (default 2, the SDK default; clamped 0–10 — every retry re-sends the whole
  prompt). Both the SDK's behavior and the retry-visibility messages read the
  same budget.
- **Effort-cap self-heal now steps down instead of switching off (F2101,
  mirrors Claude Code 2.1.314).** When an organization's plan caps a model's
  effort, the API answers `Invalid effort level`; WrongForge now walks the
  level ladder down within the same request (`high → medium → low`), learns
  the working level as a per-model cap remembered for 7 days, and clamps
  every later request straight to it — effort keeps working under a partial
  cap. A generic effort refusal (the parameter not supported at all) still
  disables effort for that model exactly as before. Found via the 2.1.316
  carve (findings.md §21).
- **The dashboard's task rail shows why a queued task is waiting** — its
  queue position and `waiting_for` reason, folded client-side from the
  `task.queued` / `task.queue_update` events.

### Fixed
- **The web UI's standalone typecheck passes again.** A missing
  `src/vite-env.d.ts` ambient-types reference made
  `tsc --noEmit -p webui/tsconfig.json` fail on the `styles.css` side-effect
  import (the vite build itself was never affected).
- **The task detail view (Inspector) now shows the events it was silently
  dropping (F2003).** `agent.report` lines — including the upstream retry
  reports — and `agent.todos`/compaction events inside a step were folded
  but never rendered; post-terminal task events now render after the last
  step; and a queued task's header shows its queue position and wait reason
  (the rail already did).
- **Startup refuses ambiguous client-key configuration (F1905).** A key in
  `AGENT_API_KEYS` / `api-keys.json` that collided with the default key (or
  another client's key) silently remapped it — quietly moving the admin
  view. Duplicate keys now fail closed with a named error.

### Documentation
- Drift audit of everything shipped since the v0.4.14 audit (F1901–F1904):
  `GET /v1/events` now documents per-client scoping instead of "all tasks";
  the Sessions section lists `SessionMeta.owner` and the
  `403 session_not_owned` scoping; the server's route-map comment matches;
  README's security notes state what a client key does and does not isolate
  (task/session data yes — the shared subscription no).

## [0.4.16] — 2026-10-30

### Added
- **`priority: "low"` on task submit keeps the last concurrency slot free for
  normal tasks (issue #7).** Helper/fleet tasks submitted as `"low"` may fill
  at most `max_concurrency - 1` slots, so a burst of them can no longer occupy
  every slot and starve the interactive task that spawned them until the
  client's own timeout turned the wait into a hard 408. `normal` (the
  default) is unchanged. With `max_concurrency` 1 a low-priority task
  effectively never starts (documented edge). Found and reported by korlog.
- **A queued task's wait is now observable.** Every time a still-queued task's
  position or block reason changes it emits a `task.queue_update` event
  (`position`, `waiting_for`, `priority`), and `GET /v1/tasks/:id` reports
  `queue_position` and `waiting_for` alongside the task document while status
  is `"queued"` — previously the only signal was the one-time `task.queued`
  event, so a task could sit in the queue for minutes in total silence.

## [0.4.15] — 2026-10-29

### Fixed
- **The auto-update re-entrancy verifier could fail spuriously on CI.** The
  F963 sweep-line measured call intervals with `Date.now()`: when one call's
  end and the next poller call's start landed in the same millisecond, the
  starts-before-ends tie-break counted the two half-open intervals as
  overlapping and reported a false `maxConcurrent=2` on correct single-flight
  code. Timestamps are now `process.hrtime.bigint()` (nanosecond, monotonic);
  the guard itself was never wrong.

### Documentation
- **README's environment table now covers every variable the code reads** —
  eight were undocumented: `ANTHROPIC_AUTHORIZE_URL`, `CLAUDE_CREDENTIALS_FILE`,
  `WRONGFORGE_ALLOW_PRIVATE_URLS` (the `web_fetch` private-address guard
  override, now also noted in Security notes), `WRONGFORGE_CC_RECOVERY`,
  `WRONGFORGE_COUNT_TOKENS`, `WRONGFORGE_DEBUG`, `WRONGFORGE_SUPERVISED_CHILD`
  (set automatically by the supervisor) and `WRONGFORGE_UPDATE_REPO`.
- **TASKS-API.md's HTTP error table now lists `404 unknown_server`** — the
  code an MCP call returns when the named server does not exist (already
  documented in MCP.md; the protocol reference's table simply missed it).

## [0.4.14] — 2026-10-26

### Fixed
- **Auto-compaction never fired for cached sessions, so they grew until the
  API's hard `prompt is too long` limit.** `context_tokens` was computed as
  uncached input + output only; with prompt caching the API's `input_tokens`
  is just the uncached tail, so a session whose real prompt had grown to
  ~1M tokens reported ~1-2k and neither `compact_at` (150k) nor the in-task
  `clear_at` guard could ever trigger. Cached input (read + write) is now
  included, so the reported context size is the true next-request prompt
  size. Found and reported by korlog (#5).
- **A very large session could brick itself permanently: once its
  transcript outgrew the summarizer's 4k-token output budget, every
  compaction attempt failed with the same error forever** (each retry
  re-running the expensive summarizer; every task on the session failing
  `context_overflow`; `/compact` returning 502). The summarizer now
  escalates once to a 64k output budget, and if even that cannot finish it
  recovers mechanically: the oldest turns are dropped behind an explicit
  "[Session recovery] …" placeholder (the full original conversation is
  archived next to the session files) instead of installing a truncated
  summary or throwing. Found and reported by korlog (#6).
- **Compacting a session manually could silently drop a task's completed
  turn from the session's live history.** `POST /v1/sessions/:id/compact`
  checks that the session is idle, then spends seconds summarizing — and a
  task submitted for that session during those seconds could start and even
  finish inside the window, so the summary (built from the earlier
  snapshot) was installed over a history that now contained the task's
  turn: the turn vanished from everything the session would resume from,
  surviving only in the archive file, with no error anywhere. The
  compaction now compares the stored history against the snapshot the
  summary was built from and refuses with `409 session_busy` ("the session
  changed while the summary was being written") instead of installing a
  stale summary; a still-running task is unaffected (its turn appends to
  the compacted history when it finishes).
- **The installers could install an unverified binary when the checksums
  download itself failed**, silently skipping the promised SHA256
  verification (`curl … | bash` on Unix; `irm … | iex` on Windows) — the
  opposite of the compiled binary's own self-update rule, which refuses
  unverified bytes outright. A missing `SHA256SUMS.txt` download, a missing
  asset line, or (on Unix) a system without a sha256 tool now all abort the
  install with a clear "refusing to install an unverified binary" message
  instead of proceeding unchecked. The installer test suite's mock also now
  serves a real checksums file, so the verification path is genuinely
  exercised, with new fail-closed regression cases for both failure modes.

## [0.4.13] — 2026-10-23

### Fixed
- **A session turn that ended in an unanswered tool call could permanently
  desync a session's reported `message_count` from what it would ever
  actually return**, with no error and no log line. `SessionStore` already
  repairs this exact shape on read (`load()`/`page()` both drop a dangling
  assistant tool-call tail left by a crash mid-append), but `appendTurn()`
  — the write boundary — trusted its caller completely and wrote such a
  tail verbatim, bumping the counter as if nothing were wrong; the very
  next read would then silently drop that message, leaving the counter
  wrong forever (or until an unrelated compaction happened to recompute
  it). `GET /v1/sessions` serializes that counter directly, so the drift
  was externally visible. `appendTurn()` now applies the same repair
  before writing, so the counter and the stored history can never
  disagree.
- **The automatic self-update idle poller (`WRONGFORGE_AUTO_UPDATE=1`) could
  start downloading the same release multiple times at once** on a
  connection slow enough that one download outlasted the poll interval
  (every 2 minutes by default) — nothing stopped the next tick from trying
  again while a previous attempt was still in flight, the same defect shape
  already found and fixed once in the periodic maintenance scheduler. Each
  overlapping attempt independently re-checks GitHub and re-downloads the
  release asset into memory, wasting bandwidth and API calls and risking
  real resource exhaustion on a constrained host. The poller now waits for
  a previous attempt to finish (success, already-current, or failure)
  before starting another.
- **The tool gateway's discovery cache could grow without bound over a
  server's lifetime** when an orchestrator uses a distinct per-task gateway
  token (a reasonable, even recommended, security practice) — the cache key
  includes the token, so every task added one permanent entry that was
  never evicted. The cache is now capped, evicting the oldest entry once
  the limit is reached.
- **A tool exposed through the gateway or an MCP server could be given an
  incorrect "required" field** when its input schema used `oneOf`/`anyOf`
  and the first listed alternative required nothing — the merge that
  builds the model-facing schema silently dropped that alternative's "this
  branch demands nothing" signal when it came first, so a field only
  required by a *later* alternative could incorrectly survive as required
  on every call. The model was never told anything the schema's own
  `oneOf`/`anyOf` didn't already describe, just the required-field summary
  — now order-independent, as the merge's own documented contract always
  intended.

## [0.4.12] — 2026-10-23

### Fixed
- **A one-off transient write hiccup on a task's TERMINAL event (`task.completed` /
  `task.failed` / `task.cancelled` / `task.timed_out`) could silence that task
  forever for its live subscribers and its webhook**, even though the task's
  own record correctly showed it had finished. Unlike an intermediate event —
  where the next heartbeat/step/tool event heals a dropped one — the terminal
  event is a task's last word, so a single failed `events.jsonl` append (e.g.
  a brief antivirus/indexer file lock on Windows) had no later chance to
  recover. The terminal event's durable write is now retried a few times
  before giving up; a genuinely broken store (every attempt fails) still
  correctly stays silent rather than handing out an unresumable event, so the
  existing gap-free `seq` guarantee is unchanged.
- **A client disconnecting mid-stream from `POST /v1/messages` made that call
  permanently invisible on the dashboard's Proxy tab** — not even a partial
  entry — even though it genuinely reached upstream (tokens already billed).
  The tap's `finish()` only ran on the piped stream's `"end"`/`"error"`
  events; a client hang-up instead calls `stream.destroy()`, which fires
  neither. `finish()` now also runs from the response's own `"close"` handler
  (idempotent, so a normal completion that fires `"end"` then `"close"` still
  only emits one tap event), and such a call is marked `response_truncated`
  since whatever was captured is necessarily incomplete.
- **Importing a corrupted or malformed Claude Code credentials file could crash
  the import instead of reporting a clear error**, and in the worst case could
  make WrongForge treat the adopted session as never expiring. A `expiresAt`
  value that round-trips through JSON as `Infinity` (e.g. a numeric literal too
  large for a double, from disk corruption or a future Claude Code bug) passed
  the existing `typeof === "number"` check, then crashed the import's own
  success-logging line (`new Date(Infinity).toISOString()` throws
  `RangeError: Invalid time value`) — or, had that line not existed, would have
  made the token's expiry check always false. `importFromClaudeCode()` now
  rejects a non-finite `expiresAt` the same way the OAuth token endpoint's
  response is already validated, falling back to the same one-hour default
  used for a genuinely missing field.
- **If `wrongforge update` failed to move the new binary into place AND the
  automatic rollback of the original binary also failed** (e.g. the whole
  directory became briefly locked/read-only — the same condition that broke
  the first move), the rollback's own raw error used to silently replace the
  real diagnostic, and the operator was never told that their previous,
  working binary was still sitting safely at `<exe>.old.<pid>` — just renamed
  aside, not lost. The thrown error now names both failures and gives the
  exact path to rename back by hand.

## [0.4.11] — 2026-10-20

### Fixed
- **A proxy client's own long-running conversation could get a `cache_control`
  ttl-ordering 400 forever after** (`the API rejected cache_control — prompt
  caching is disabled for this process`) — `applyCacheBreakpoints` always
  marked the newest breakpoint with the server's *current* cache mode, but a
  client pointed at WrongForge's `/v1/messages` proxy (`ANTHROPIC_BASE_URL`)
  manages its own growing history, which can already carry a `cache_control`
  with a different ttl than the server's default. Mixing ttls in one request
  is exactly what Anthropic rejects outright, and the existing self-heal then
  disabled caching process-wide (proxy calls have no session to scope the
  disable to) for every client, not just the one that triggered it. Fixed by
  scanning the body for an already-established ttl and pinning any new
  marker to match it, rather than always using the server's current default.
  WrongForge's own agent/task requests are unaffected (they're always built
  cache_control-free from scratch, so this is a no-op there); the existing
  self-heal remains in place as a last-resort safety net.

## [0.4.10] — 2026-10-19

### Added
- **The Proxy tab now surfaces the detail a real debugging tool needs**:
  rate-limit headers (`anthropic-ratelimit-{requests,tokens}-{remaining,limit}`)
  as a compact, color-warning chip on every call; the full request/response
  header sets (one click away, including whichever `anthropic-beta` flags the
  client itself sent and the upstream `request-id` for support tickets); error
  responses now summarize as `error: <type> — <message>` instead of falling
  back to a bare "raw" label; and the usage line shows prompt-cache
  read/write token counts when present, not just input/output. All additive —
  the real client's request/response bytes are untouched, this only extends
  what the dashboard's own capped copy carries.

## [0.4.9] — 2026-10-19

### Fixed
- **`wrongforge update` (and `WRONGFORGE_AUTO_UPDATE`) always refused to run**
  with "self-update replaces the compiled binary" — on every binary, every
  platform, since the feature shipped (GitHub issue #2). `isCompiledBinary()`
  also required `process.argv[0]` to contain `"wrongforge"`, but in a Bun
  `--compile` executable `argv[0]` is always the fixed string `"bun"` (the
  runtime name), never the executable's own path — confirmed by compiling
  and running a real binary. Fixed by dropping that check; `process.execPath`
  (the real on-disk path) was already reliable on its own. Verified against
  both a freshly-compiled local binary and a real published release.
- **A clean binary install had no way to refresh its OAuth token**
  (`OAuth client is not configured`, `wrongforge status` showing
  `clientConfigured: false` — GitHub issue #4): `scripts/install.sh` /
  `install.ps1` only ever installed the binary, never the OAuth client
  config (`npm run config:init`, the only existing way to create it, is
  source-only). Both installers now write `~/.wrongforge/oauth.json` (or
  `install.ps1`'s `%USERPROFILE%\.wrongforge\oauth.json`, respecting
  `WRONGFORGE_HOME`) from the repo's public `oauth.config.example.json` when
  it doesn't already exist — client identifiers still live outside the
  source (no policy change), the installer just automates the copy. A
  failed download never fails the install.

## [0.4.8] — 2026-10-19

### Added
- **Dashboard "Proxy" tab: human-readable request/response summaries**
  instead of a flat "raw" button. Model, message/tool counts and the last
  message's content (text/tool_use/tool_result/thinking) for requests;
  finish reason, token usage and reply content for responses — for
  streaming calls too, by replaying the raw SSE event text (`proxy.ts`
  never reconstructs it server-side) into an approximate final message
  client-side. Click still opens the full raw JSON, unchanged
  (`webui/src/lib/anthropicSummary.ts`). Also fixed the Sessions tab's
  message preview, which never actually summarized a stored tool call: it
  checked for the Anthropic wire format's `tool_use`/`name` instead of the
  stored session format's `tool-call`/`toolName` (`src/messages.ts`), so
  every tool call fell through to a generic `(tool-call)` placeholder; now
  shows `⇢ toolName(input)`.

## [0.4.7] — 2026-10-18

### Added
- **`wrongforge refresh`** (`npm run refresh`): a lightweight, serve-independent
  way to use the refresh token on demand. `serve`'s own idle keep-alive only
  runs while the server is up; reverse-engineering Claude Code found that the
  refresh token itself dies after roughly 30 days of disuse (renewed on every
  successful refresh — `re/notes/findings.md` §14). Running this on a shorter
  schedule (cron, systemd timer, Windows Task Scheduler) keeps a long-idle
  session alive without ever running real Claude Code. Deliberately not a
  bare token-endpoint call: carved CC never refreshes in isolation either
  (every refresh site found guards a real request and fires right before
  one), so this follows the refresh with the same `GET /v1/models`
  `wrongforge models` already makes — keeping the traffic inside a shape
  real CC also produces, and confirming the token actually works.
- `oauth.status()` now reports `refreshTokenExpiresAt` (null when the token
  endpoint hasn't sent it — not "never expires") alongside the access token's
  expiry.

### Fixed
- `src/oauth.ts` now records `refresh_token_expires_in` from the token
  endpoint when present, carrying the previous value forward on a refresh
  response that omits it (mirrors Claude Code's own merge behavior) instead
  of discarding it.
- **`context_overflow` from a single oversized tool result** (reported via
  WrongStack): a tool result could push a request past the model's context
  window (up to a hard `400`) without the in-task guard ever reacting, because
  it only checks the API's own usage numbers from the *previous* response —
  which don't yet include a result just appended, and arrive one request too
  late for a result that alone jumps past the limit. Also, nothing bounded
  the size of a tool result generically: built-in tools already self-limit
  their own output, but MCP/gateway tools did not. Fixed with two new
  defenses (`src/compaction.ts`, `src/agent.ts`): (1) any single tool result
  bigger than `WRONGFORGE_MAX_TOOL_OUTPUT_CHARS` (default 400 000 chars) is
  clipped the moment it comes back, regardless of which tool produced it; (2)
  the in-task guard now also re-checks right after a tool result is
  appended, using a same-turn character-count estimate of that result (the
  real usage numbers still win on the next response — the estimate only
  decides *when* the guard reacts).
- **Cache-control TTL ordering error** (`a ttl='1h' cache_control block must
  not come after a ttl='5m' cache_control block`, reported via WrongStack on
  a long-running session): a task could pick its own prompt-cache mode
  (`5m`/`1h`/`off`) independent of what earlier tasks on the same
  `session_id` had used — and since `cache.ts` only ever marks the newest
  message (never touching an older `cache_control` already embedded in
  history), mixing modes across a session's turns could leave an
  inconsistent TTL ordering the API rejects outright, with no way for the
  session to recover on its own. Fixed: a session's cache mode is now locked
  in by its **first** turn (`SessionMeta.cache_mode`) — every later task's
  `cache` request is silently overridden to match (logged as
  `session.cache_mode_locked`); and the rare case where this error still
  occurs is now recognized (`isCacheOrderingError`) and recovered from
  exactly like `context_overflow` — the session is flagged and compacts
  automatically on the next task (new `cache_ordering_error` error code).
  Also, the cache-rejection fallback (disabling `cache_control` after the
  API refuses it) is now scoped **per session** instead of process-wide — a
  single broken session no longer silently turns off caching for every
  other session the server is also handling.
- **A failed task reported no `result` at all on `context_overflow` and
  `cache_ordering_error`** — a caller got the error message but never
  `context_tokens`/`context_window`/`context_percent`, so there was no way
  to tell how close it got (only that it failed). Both now include `result`
  whenever a turn actually ran, same as every other failure mode.

## [0.4.6] — 2026-10-18

### Added
- **Automatic self-update** (`WRONGFORGE_AUTO_UPDATE=1`, off by default):
  `serve` installs a newer release on its own once the server is idle (no
  queued/running task) — a release already found by the existing daily check
  is downloaded and sha256-verified while still fully serving, and only once
  that succeeds does it close the listening port and install it. Compiled
  binary only, same as `wrongforge update`. `WRONGFORGE_AUTO_UPDATE_POLL_MS`
  (default 2 min) controls how often the idle+update-available condition is
  checked. `/v1/info` → `auto_update: { enabled, supervised }`.
- **Crash-restart supervisor** (`WRONGFORGE_SUPERVISE=1`, off by default):
  `serve` runs the real server as a child and restarts it on exit — crash or
  otherwise — with capped exponential backoff (1 s → 60 s, reset after a
  minute of uptime). Its own `Ctrl+C`/`SIGTERM` is forwarded to the child and
  does not trigger a restart. Combine both for a self-healing,
  self-updating server: `WRONGFORGE_SUPERVISE=1 WRONGFORGE_AUTO_UPDATE=1
  wrongforge serve`. See `docs/RELEASE.md`.
- `src/update.ts`: `selfUpdate()` split into `prepareUpdate()` (network:
  check, download, sha256 verify) and `installUpdate()` (filesystem: swap +
  respawn + exit) — `wrongforge update` still calls both in sequence; the
  split is what lets the automatic path verify an update before tearing
  anything down for it.

## [0.4.5] — 2026-10-18

### Added
- **Dashboard "Proxy" tab**: live visibility into every call to the
  Anthropic-compatible endpoint (`/v1/messages`, `/v1/messages/count_tokens`,
  `/v1/models`) — method, model, `stream`/`auth_mode`, status, duration, and
  the request/response bodies themselves (expandable). Fed by a new
  `proxy.call` SSE channel on `GET /v1/events`, kept separate from the task
  event firehose so its (larger) bodies never crowd it out. Capturing a
  response never buffers or delays what the real client receives — it mirrors
  a size-capped copy alongside the untouched pass-through pipe
  (`WRONGFORGE_PROXY_TAP_BODY_CAP`, default 8 KB; independent of
  `WRONGFORGE_PROXY_MAX_BODY`, which bounds what the proxy itself accepts).

## [0.4.4] — 2026-10-18

### Fixed
- **Login grant scope narrowed without `code=true`** (issue #3, community
  report + `re/notes/findings.md` §12): the authorize-URL request was missing
  a parameter Claude Code always sends (`code=true`), carved from CC 2.1.300's
  own builder. Without it the granted scope could come back missing
  `user:inference` (model calls then fail even though sign-in looked fine).
  Added; the OAuth client (console/subscription) endpoint choice itself was
  already correct — confirmed scope selection is unrelated to the host.
- `src/oauth.ts`'s outdated note claiming `api.anthropic.com` rejects the
  token-endpoint request shape is removed — independently probe-verified by a
  community report that it currently accepts it (any User-Agent). WrongForge
  keeps targeting `platform.claude.com` (Claude Code's own `TOKEN_URL`) rather
  than relying on that undocumented leniency.

## [0.4.3] — 2026-10-18

### Added
- **Anthropic-compatible endpoint** — the server now mirrors the Anthropic
  Messages API itself (`POST /v1/messages` streaming and non-streaming,
  `POST /v1/messages/count_tokens`, `GET /v1/models[/:id]`). Any Anthropic
  client (Claude Code, the SDKs, WrongStack) can point `ANTHROPIC_BASE_URL`
  at WrongForge and use the server's credentials: with OAuth the request
  rides the same Claude Code client signature the agent uses (subscription
  billing, 401 auto-refresh, 400 self-heal); with `ANTHROPIC_API_KEY` it is a
  byte-for-byte passthrough. Client auth accepts `x-api-key` in addition to
  Bearer on the whole API. Responses (status, SSE, rate-limit headers, error
  envelopes) pass through untouched. `WRONGFORGE_PROXY=0` disables the
  surface; `WRONGFORGE_PROXY_MAX_BODY` caps bodies (default 32 MB).
- **OAuth idle keep-alive:** the server now refreshes its session on its own
  while running (checks every `WRONGFORGE_TOKEN_KEEPALIVE_MS`, default 5 min;
  refreshes once the access token has <15 min left, with exponential backoff
  after failures). An idle server used to leave the token chain untouched
  between tasks until the refresh token died of disuse — the "run Claude Code
  once in a while" ritual; running the server is now enough.

### Fixed
- **Import and self-healing after Claude Code 2.1.302** (issue #3): Claude
  Code moved its credentials from `~/.claude/.credentials.json` into the macOS
  Keychain. `import` (and the automatic session recovery after a dead refresh
  token) now falls back to reading the Keychain item `Claude Code-credentials`
  when the legacy file is gone, so no manual `security find-generic-password`
  export or launchd cron is needed.
- **Token exchange / refresh 429s — root cause found and probe-verified**
  (issue #3, `re/notes/findings.md` §11): the token endpoint 429-rate-limits
  the generic `User-Agent: anthropic` WrongForge sent — the same JSON request
  with a `claude-cli/…` UA (or no UA) is processed normally. The request now
  carries the Claude Code user-agent, the refresh body includes the granted
  `scope` (both carved from CC 2.1.300), and the default OAuth endpoints moved
  to `platform.claude.com` — the old `console.anthropic.com/v1/oauth/token`
  now answers 404. Existing `oauth.json` / env overrides keep winning.

## [0.4.2] — 2026-10-16

### Fixed
- Import Claude Code credentials containing a UTF-8 BOM and distinguish
  unreadable files, malformed JSON and missing access tokens in diagnostics.
- Keep normal CLI errors concise; retain stack traces with `WRONGFORGE_DEBUG`.
- Stop webhook retries and queued deliveries when the task manager shuts down.

### Added
- Regression tests for credential diagnostics, CLI debug output and webhook
  shutdown. Releases now require typecheck, the full test suite and a native
  binary version check on Windows, Linux and macOS before publication.

## [0.4.1] — 2026-10-16

### Fixed
- Recover incomplete session records after crashes and preserve sessions when
  compaction reaches its output limit.
- Harden OAuth refresh races, task deadlines, MCP connection shutdown and
  overlapping maintenance passes.
- Improve self-update rollback handling, web address validation and dashboard
  event replay across reconnects.

### Added
- **One-line installers** — `curl … install.sh | bash` (Linux/macOS) and
  `irm … install.ps1 | iex` (Windows): sha256-verified download from the
  latest release, PATH setup, macOS quarantine clearing. Release checksums
  are now computed once over all platform binaries (SHA256SUMS.txt covers
  every asset).

## [0.4.0] — 2026-10-16

The binary release: WrongForge ships as a single executable, keeps itself
current, and its requests are byte-faithful to a real Claude Code client.

### Added
- **Single-file executable** — `npm run build:binary` compiles with Bun
  (`--compile`): the webui dashboard and the default prompt guides are
  embedded; no Node, no npm, no `webui/dist` needed on the target machine.
  Binary commands: `wrongforge serve | update | version` plus the source-mode
  commands. ([docs/RELEASE.md](docs/RELEASE.md))
- **GitHub Releases** — pushing a `v*` tag builds Windows, Linux and macOS executables (macOS arm64 + x64)
  with sha256 checksums and attaches them to a release
  (`.github/workflows/release.yml`, repo `WrongStack/WrongForge`).
- **Update checks & self-update** — `serve` checks `releases/latest` at
  startup and daily; a newer version surfaces in the serve banner, the log,
  `/v1/info.update` and as a red dashboard chip. `wrongforge update`
  downloads the platform asset, verifies its sha256 digest against the
  release metadata, swaps the running executable in place (Windows-safe
  rename dance) and respawns with the same arguments. Kill switches:
  `WRONGFORGE_UPDATE_CHECK=0`, `WRONGFORGE_UPDATE_REPO`.
- **Request parity with Claude Code 2.1.300** (reverse-engineered from
  captured traffic + the carved executable): the exact 15-beta list in the
  captured order, `count_tokens` preflight before every streaming turn, the
  `/api/hello` startup ping, `thinking: adaptive`, `context_management`,
  the `safeguards` dangerous-tool-use classifier context, `max_tokens`
  128000 on main turns, pinned `x-stainless-runtime-version`
  (`v26.3.0`), SDK retry-count preserved. Each injected field self-heals
  away with a retry when an endpoint refuses it.
- **Effort, actually working** — `effort` rides inside `output_config`
  behind the `effort-2025-11-24` beta (the old top-level field was rejected
  with "Extra inputs are not permitted"; live-verified accepted now). Five
  levels `low|medium|high|xhigh|max` (+`off`), capability table mirroring
  CC's model list, per-model levels served in `/v1/info` → `model_details`
  and shown in `npm run models`. Learned rejections persist 7 days.
- **Gateway tool shadowing** — an orchestrator tool named `<prefix><built-in>`
  (`wstack_read`) now hides that built-in from the model, deterministically
  routing the operation through the orchestrator (`gateway.shadow_builtins:
  false` to keep both; live-verified end-to-end).
- **OAuth self-healing** — when the refresh token dies, WrongForge adopts
  Claude Code's own session from `~/.claude/.credentials.json`
  automatically and refreshes it; the manual `npm run import` ritual is only
  needed when Claude Code's token is dead too.
- **Dashboard: Info tab** (models & effort levels, plan usage 5h/weekly,
  limits, tools, storage) and **Insights tab** (per-model usage/outcomes,
  tool activity — replaces the old React-Flow graph; `@xyflow/react`
  removed, bundle −33%).
- **Backlog replay for task events** — `/v1/events` now replays the newest
  ≤300 task events **from disk** on connect (plus the http traffic ring), so
  a dashboard opened late — or after a serve restart — still shows the
  rounds, tool calls and texts that ran while it was away.
- Dashboard actions: **run a test task / test request** buttons, task
  cancel, idle diagnostics strip, one-screen control-room layout
  (task rail | live feed | inspector).

### Changed
- `/v1/info` exposes `model_details`, `workdir.suggestion`, `limits`,
  `webhook`, `dirs` and `update`; `effort.levels` includes `xhigh`/`max`.
- `docs/INTEGRATION.md` and `docs/TASKS-API.md` updated for all of the
  above; new `docs/RELEASE.md`.
- Project license: **MIT**.

## [0.3.0] — 2026-10-15

The billing breakthrough and the first dashboard.

- **Plan billing solved** — requests carry the Claude Code client signature:
  the `x-anthropic-billing-header` system block (captured from a real CC
  run through a local proxy), client UA/`x-app`/`x-stainless-*` headers and
  the CC beta set. Subscription-plan billing and prompt caching work
  end-to-end.
- **Migration to the official SDKs** — `@anthropic-ai/sdk` + the official MCP
  SDK (finish-reason vocabulary, baseURL normalization).
- **Live web dashboard** (React 19 + Radix + Vite, served at `/` with
  `?key=` auth): live event firehose with `step.request` (what went out to
  the model) / `step.finished` (what came back), task table, sessions,
  graph.
- **HTTP traffic monitoring** — `http.request` frames on the global SSE
  feed, the serve-console live view (`src/liveview.ts`) and SSE backlog
  replay of recent requests.
- **Tool-schema flattening** — gateway/MCP tool schemas with top-level
  `oneOf`/`anyOf`/`allOf` are flattened before `/v1/messages` (live 400
  incident fixed).
- Model-aware reasoning effort (initial version, top-level field),
  `WRONGFORGE_EFFORT`, `/effort` REPL command.

## [0.2.0] — 2026-10-15

The orchestrator surface.

- Durable **task store** (`tasks/<id>/task.json` + `events.jsonl`), event
  replay, heartbeats, timeouts, cancellation, recovery after restarts.
- **HTTP task API** — submit (wait/stream/async), status, events (SSE /
  long-poll / replay), global `/v1/events` feed, signed webhooks with
  retries, `/v1/sessions` with compaction, maintenance.
- **Tool gateway** — orchestrator-lent tools over HTTP (discovery or
  inline, allow/deny, name prefix `wstack_`, schema flattening).
- **MCP servers** — config file, typed `mcp_*` tools, per-task selection,
  management API + REPL tools.
- REPL (`npm start`) with `/model`, `/effort`, `/status`, `/usage`.

## [0.1.0] — 2026-10-15

Initial release: the agent itself — OAuth sign-in (login/import), the tool
set (bash, read/write/edit, ls/glob/grep, web_fetch, todos,
report_progress), the Claude turn loop with streaming, prompt guides,
configuration and the data directory.
