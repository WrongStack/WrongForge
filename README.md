# WrongForge

> [!WARNING]
> **Experimental software, provided as-is.** No warranty of any kind — express
> or implied. The authors and contributors accept no liability for any damage,
> data loss, account actions or other consequences of using this software.
> It runs shell commands and edits files on your machine, drives your Claude
> account, and depends on undocumented client behavior that may change without
> notice. Use at your own risk; review the code before trusting it.

A standalone agent for WrongStack that performs Claude Code-style work
(shell, files, search, web, MCP) and exposes it two ways:

- a **chat REPL**, and
- an **HTTP task API** — an orchestrator submits tasks, the agent works on
  them and every step is streamed back as events (SSE, long-poll or signed
  webhooks), with a **live dashboard** on top.

It ships as a **single-file executable** (dashboard and guides embedded, MIT
licensed — see [releases](https://github.com/WrongStack/WrongForge/releases))
or runs from source on Node/TypeScript. It signs in with your Claude account
(OAuth) and talks to `api.anthropic.com` with Bearer tokens, or with a regular
console API key. Built on the official Anthropic SDK, `zod` and the MCP SDK;
no other runtime services are needed.

## Contents

- [Models](#models) · [Installation](#installation) · [Usage](#usage)
- [Privacy — what is sent](#privacy--what-is-sent-to-the-other-side)
- [Tools](#tools) · [MCP servers](#mcp-servers) · [Tool gateway](#tool-gateway)
- [HTTP task API](#http-task-api) · [Anthropic-compatible endpoint](#anthropic-compatible-endpoint) · [Sessions & context](#sessions--context-management)
- [Architecture](#architecture) · [Configuration](#configuration) · [Data directory](#data-directory)
- [Tests](#tests) · [Security notes](#security-notes) · [Known limitations](#known-limitations)

**Documentation:** [docs/TASKS-API.md](docs/TASKS-API.md) (protocol reference) ·
[docs/INTEGRATION.md](docs/INTEGRATION.md) (client guide) ·
[docs/TOOL-GATEWAY.md](docs/TOOL-GATEWAY.md) · [docs/MCP.md](docs/MCP.md) ·
[docs/RELEASE.md](docs/RELEASE.md) (binaries & self-update) · [CHANGELOG.md](CHANGELOG.md)

## Models

| Model ID | Tier | Price in/out ($/MTok) |
|---|---|---|
| `claude-sonnet-5-5` | **default** — balanced coding/agent | 2 / 10 |
| `claude-opus-5-5` | Anthropic's recommendation for most workloads | 4 / 20 |
| `claude-fable-5-1` | deepest reasoning, long agent runs | 10 / 50 |
| `claude-haiku-5-5` | fast/economical | 0.10 / 0.50 |

All have a 1M-token context and 128K output; dateless IDs are pinned
snapshots. This list is the built-in fallback (`KNOWN_MODELS` in
`src/agent.ts`). For the **live list** run `npm run models` or `/models` in the
REPL — it queries `GET /v1/models` with your credentials.
Source: [Models overview — Claude Platform Docs](https://platform.claude.com/docs/en/models/overview).

## Installation

**One line (recommended):**

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/WrongStack/WrongForge/main/scripts/install.ps1 | iex
```

The installer exposes the command as `wrongforge` from any directory. Windows
updates both the current PowerShell session and your user PATH. Linux/macOS
installs to `~/.local/bin/wrongforge` and configures bash, zsh and fish startup
files automatically; open a new terminal afterward, or run the `export PATH=…`
line printed by the installer in your current shell (bash/zsh).

**Manual download** — pick the asset for your platform from
[releases](https://github.com/WrongStack/WrongForge/releases), put it on your
PATH and make it executable (`chmod +x`).

Rename the downloaded asset to `wrongforge` (`wrongforge.exe` on Windows).

| Platform | Asset |
|---|---|
| Windows x64 | `wrongforge-windows-x64.exe` |
| Linux x64 | `wrongforge-linux-x64` |
| macOS Apple Silicon | `wrongforge-macos-arm64` |
| macOS Intel | `wrongforge-macos-x64` |

Then:

```bash
wrongforge import      # reuse your existing Claude Code session
wrongforge serve      # HTTP task API + dashboard on :8787
wrongforge update     # later: install the newest release (sha256-verified)
```

Self-contained: the dashboard and the default tool guides are embedded. On
macOS the binary is unsigned — clear Gatekeeper once with
`xattr -d com.apple.quarantine wrongforge-macos-*`.
`wrongforge update` keeps it current (checks run at startup and daily;
`WRONGFORGE_UPDATE_CHECK=0` disables). More: [docs/RELEASE.md](docs/RELEASE.md).

**From source** (Node 24+):

```bash
git clone https://github.com/WrongStack/WrongForge.git && cd WrongForge
npm install                    # the server/CLI
npm --prefix webui install     # dashboard build prerequisite (once)
npm run config:init            # writes ~/.wrongforge/oauth.json from the example
npm run webui:build            # the dashboard served at / by `serve` (optional
                               # but recommended; skip = the API still works)
```

**Build the binary yourself** (what the releases contain — needs
[bun](https://bun.sh)):

```bash
npm run build:binary    # → release/wrongforge-<os>-<arch>[.exe], webui embedded
```

The OAuth client registration (client ID, endpoints, scope) is **not part of
the code**. It is loaded from env vars (`CLAUDE_OAUTH_CLIENT_ID`, …) or from
`~/.wrongforge/oauth.json` (path override: `CLAUDE_OAUTH_CONFIG`). The whole data
directory can be moved with `WRONGFORGE_HOME`. An existing `~/.wrongminiagent/`
(the project's former name) is copied to `~/.wrongforge/` automatically on first
run and left untouched. `oauth.config.example.json` holds the template; the
client ID there is a public application-registration value shared by every
install of that app.

**Alternative without OAuth:** set `ANTHROPIC_API_KEY` to a console API key. The
OAuth/Claude Code client signature described below is then bypassed entirely
and requests bill to the key's credits instead of a subscription.

## Usage

From a binary, the same commands run without `npm run` (`wrongforge import`,
`wrongforge serve`, …; plus `wrongforge update` and `wrongforge version`).
From source:

```bash
npm run import            # reuse your existing Claude Code session (no login needed)
npm run login             # alternative: browser login -> paste the shown code
npm run status            # token status (expiry/scope; tokens are never printed)
npm run refresh           # use the refresh token now, without starting serve
npm run models            # live model list for your account
npm start                 # chat REPL
npm run serve             # HTTP task API (port 8787)
npm run mcp -- list       # manage MCP servers from the terminal
npm run webui:build       # build the live dashboard once (served at / by `serve`)
npm run webui             # dashboard development (Vite on :5173, proxying the API)
```

Other `main.ts` subcommands: `url` (print an authorize URL), `logout`.

**Serve-console live view:** while `npm run serve` runs in a terminal, every
incoming HTTP request and every task event prints as one colored line right
there — `GET /v1/tasks 200 2ms`, `● task.started`, `⇢ step.request …`,
`⚑ tool.started ls`, `✔ task.completed` — so you can watch WrongStack's
traffic without opening anything else (heartbeats are skipped; `NO_COLOR`
disables the colors; `WRONGFORGE_LIVE=0` turns it off).

```
┌ status bar: live · idle · rpm · tokens · last request ── [▶ test task] ┐
├ TASKS       │ LIVE FEED                  │ SELECTED TASK / SYSTEM      │
│ rail:       │ http rows + task events    │ per-step model round-trips, │
│ status, id, │ (step.request/finished,    │ tool calls with io, agent   │
│ prompt,     │ tool.started/finished,     │ text — or the system panel  │
│ cancel ✕    │ agent.text)                │ (models, usage, tools)      │
└─────────────┴────────────────────────────┴─────────────────────────────┘
```

**Live dashboard** — open `http://127.0.0.1:8787/` while the server runs
(embedded in the binary; from source, `npm run webui:build` once). One screen,
five tabs: **Overview** (the control room above — task rail, live feed,
inspector), **Insights** (per-model usage and outcomes, tool activity),
**Sessions**, **Info** (models with their effort levels, plan usage, limits,
tools, storage) and **Proxy** (live request/response traffic through the
Anthropic-compatible endpoint below — see that section). The feed replays its
backlog on connect — the last ≤300 HTTP requests AND the newest ≤300 task
events **from disk**, so it survives serve restarts and shows what ran while
you were away. Buttons on the feed run a
test request or a tiny test task on demand; running tasks can be cancelled
from the rail. The browser asks for the server API key once (`?key=` on the
URL also works — browsers cannot set headers on EventSource); only the shell
is public, all data stays behind the key.

`npm run import` reads `claudeAiOauth` from `~/.claude/.credentials.json`
(Claude Code CLI's stored session) into this app's encrypted token store — and,
since Claude Code `2.1.302` moved its credentials into the **macOS Keychain**
(service `Claude Code-credentials`), directly from there when the file no
longer exists. The token refreshes through the same endpoint when it expires,
so a single import keeps working — and when the refresh token dies, WrongForge
adopts Claude Code's current session (file or Keychain) automatically;
`npm run import` is only needed when Claude Code's own token is dead too
(run Claude Code once and the next request recovers). While the server runs,
an idle keep-alive refreshes the session on its own (see
`WRONGFORGE_TOKEN_KEEPALIVE_MS`) — no need to open Claude Code periodically
just to keep the tokens alive.

**Keeping a session alive without `serve` running:** the refresh token itself
expires after prolonged disuse (reverse-engineered from Claude Code: on the
order of 30 days, renewed on every successful refresh — see
`re/notes/findings.md` for anyone building from a full checkout). The idle
keep-alive above only runs while `serve` is up; if it is not — a closed
laptop, a box that starts WrongForge on demand — nothing touches the refresh
token in the meantime. Run `wrongforge refresh` (or `npm run refresh`) on a
schedule shorter than that window to keep a long-idle session alive, with no
real Claude Code involved: it performs the same refresh-token exchange
`serve`'s own keep-alive already does, immediately followed by the same
`GET /v1/models` `wrongforge models` makes — real Claude Code never refreshes
in isolation either (every refresh site found while reverse-engineering it
guards a real request and fires right before one), so this keeps the traffic
inside a shape real CC also produces, and incidentally confirms the token
actually works rather than just that the endpoint accepted it:

```bash
# cron, weekly
0 3 * * 0 /path/to/wrongforge refresh >> ~/.wrongforge/logs/refresh.log 2>&1
```

```powershell
# Windows Task Scheduler, weekly
schtasks /Create /SC WEEKLY /TN "WrongForge token refresh" /TR "wrongforge.exe refresh"
```

> Loopback redirects (`http://127.0.0.1:…/callback`) are **not supported** for
> this client: the server rejects them. The only registered redirect is
> `https://platform.claude.com/oauth/code/callback`, so the paste-the-code
> flow (the standard Claude Code CLI flow) is the only login path.

**REPL commands:** `/help /status /usage /model <id> /effort [lvl] /models /reset /tools /exit`.
`/usage` shows the plan limits (5-hour window, weekly, extra usage). Ctrl+C
interrupts a running turn (the turn is discarded from the history); when idle it
quits. The REPL runs up to 20 model steps per turn. Default model is
`claude-sonnet-5-5`; override with `CLAUDE_MODEL` or `/model`. Reasoning
effort defaults to `WRONGFORGE_EFFORT` (high); `/effort low|medium|high|xhigh|max|off`
changes it for the session (clamped to what the model supports — the levels
per model are in `/v1/info` → `model_details`).

## Privacy — what is sent to the other side

WrongForge is **not** an anonymous client. To be served with a subscription
(OAuth) token, the Anthropic backend requires requests to look like they come
from Claude Code, so `src/provider.ts` reproduces that client signature. This
is what leaves your machine:

| Request | Contents |
|---|---|
| authorize URL | `client_id` (from your config), `code=true` (the flag Claude Code's own client always sends — omitting it can narrow the granted scope), `redirect_uri`, `scope`, one-time PKCE `code_challenge` + `state` |
| token endpoint | `grant_type`, `client_id`, `code` / `refresh_token`, `redirect_uri`, `code_verifier`, `scope` (JSON body) |
| `POST /v1/messages` | `Authorization: Bearer <token>`, `anthropic-version`, the beta list below, the conversation, the tool definitions, and the identification described next |
| `GET /api/hello` | startup liveness ping, no auth (as Claude Code does) |
| `GET /api/claude_cli/bootstrap` | once per process at startup (as Claude Code does); returns the account UUID |
| `POST /v1/messages/count_tokens` | before every streaming turn (as Claude Code does): model, messages, tools |
| `GET /v1/models`, `GET /api/oauth/usage` | only when you ask for models / usage; Bearer token |

Identification on `/v1/messages` (OAuth mode only):

- **Headers:** `User-Agent: claude-cli/2.1.300 (external, sdk-cli)`, `x-app: cli`,
  `x-claude-code-session-id` (random per process, never stored),
  `anthropic-dangerous-direct-browser-access`, and the `x-stainless-*` set —
  OS and CPU architecture are real; the runtime version is pinned to Claude
  Code's (`v26.3.0`) rather than your Node's.
- **`metadata.user_id`:** JSON with a **persistent random `device_id`** (64 hex
  chars, created once in `~/.wrongforge/user-id`), your **`account_uuid`**
  (cached in `~/.wrongforge/account-uuid`) and the per-process session id.
- **Body shape:** `thinking: adaptive`, a `context_management` edit list, a
  `safeguards` dangerous-tool-use classifier context (carries the task's
  working directory and your OS username), `output_config.effort`, and
  `max_tokens: 128000` on main turns — matching the captured client. Each of
  these self-heals away with a retry if an endpoint ever refuses it.
- **System prompt:** two fixed leading blocks — a billing marker
  (`x-anthropic-billing-header: cc_version=…; cc_entrypoint=sdk-cli;`) and
  `You are a Claude agent, built on Anthropic's Claude Agent SDK.` — followed by
  this app's own prompt.
- **Betas:** the exact 15-item list a captured Claude Code 2.1.300 request
  carries, in the same order (incl. `context-management-2025-06-27` and
  `dangerous-tool-use-2026-09-03` — without those two the API answers
  `400 "Third-party apps now draw from your extra usage"` — and
  `effort-2025-11-24`, which gates the `output_config.effort` field).
- Requests go to `POST /v1/messages?beta=true`.

Tokens are never printed or logged. With `ANTHROPIC_API_KEY` set, none of the
Claude Code signature, `metadata.user_id` or bootstrap call is used — the SDK
sends a plain API-key request.

> **Fragility / policy note.** Subscription access depends on emulating Claude
> Code's client fingerprint, which Anthropic can change or restrict at any time
> (and which may not be covered by the terms of your plan). The `re/` directory
> (git-ignored) holds the reverse-engineering notes and capture tools used to
> keep the fingerprint current. For anything you rely on, prefer an API key.

## Tools

Each tool lives in its own file under `src/tools/`:

| Tool | File | Purpose |
|---|---|---|
| `bash` | `bash.ts` | run a shell command: stdin closed, timeout + process-tree kill, long output keeps head **and** tail, stops on Ctrl+C / task cancel |
| `read` | `read.ts` | numbered lines (cat -n), `offset`/`limit`, `nextOffset` pagination; rejects directories/binary/>10 MB, cuts very long lines |
| `write` | `write.ts` | write new files or full rewrites (creates parent dirs, reports `created`) |
| `edit` | `edit.ts` | exact, literal replacement (`$&` is not special); unique match or `replace_all`; CRLF-aware; errors point at line numbers |
| `ls` | `ls.ts` | directory entries (dirs first, name/type/size, `truncated` flag) |
| `glob` | `glob.ts` | `**`, `*`, `?`, `[abc]`, `{ts,tsx}`; newest first |
| `grep` | `grep.ts` | regex search; modes `content` / `files_with_matches` / `count`, `context` lines |
| `web_fetch` | `web-fetch.ts` | public URL → readable text (structure kept, title, charset, binary refused, SSRF guard, redirect limit) |
| `todo_read` / `todo_write` | `todo-*.ts` | session task list (state in `todo-state.ts`) |
| `report_progress` | `report-progress.ts` | short status update to the orchestrator (surfaces as an `agent.report` event) |
| `mcp_servers` / `mcp_tools` / `mcp_call` | `mcp-tools.ts` | discover and call tools of configured MCP servers |
| `mcp_add` / `mcp_remove` | `mcp-tools.ts` | let the agent add/remove MCP servers (disable with `WRONGFORGE_MCP_AGENT_MANAGE=0`) |

Shared helpers: `util.ts` (limits, paths, error text), `glob-utils.ts` (glob
matcher + directory walker), `shell.ts` (process runner), `web-utils.ts`
(SSRF guard, HTML→text), `gateway.ts` (orchestrator tools). `index.ts`
assembles `agentTools`; `src/tool.ts` defines the tool type and `runTool`.

`glob`/`grep` skip `.git`, `node_modules` and similar directories; binary-ish
files are skipped by content sniffing. A glob without `/` (`*.json`) matches
file names at any depth. `web_fetch` attaches no credentials.

## MCP servers

WrongForge is an MCP **client**: servers are configured once and their tools
become available to the agent — individually as typed `mcp_<server>_<tool>`
tools (for `eager` servers) or lazily through `mcp_tools` / `mcp_call`.

```bash
npm run mcp -- list
npm run mcp -- add github --url https://api.githubcopilot.com/mcp/ --header "Authorization=Bearer \${GITHUB_TOKEN}"
npm run mcp -- add fs --command npx -- -y @modelcontextprotocol/server-filesystem D:/work
npm run mcp -- test github
npm run mcp -- tools github [tool]
npm run mcp -- call github search_repositories '{"query":"wrongforge"}'
npm run mcp -- import ~/.claude.json      # Claude Code / Desktop style { "mcpServers": {…} }
```

- Transports: `http` (Streamable HTTP), `sse`, `stdio`.
- Config file: `$WRONGFORGE_MCP_CONFIG`, else `~/.wrongforge/mcp.json` (mode 0600).
  Reference secrets as `${ENV_VAR}` so the file holds none. Changes are picked up
  by a running server without a restart.
- Per-server options: `--description`, `--eager`, `--required`,
  `--allow` / `--deny` (name patterns, `*` suffix), `--timeout`.
- Connections are pooled and closed after an idle period
  (`WRONGFORGE_MCP_IDLE_MS`, default 5 min; tool lists cached
  `WRONGFORGE_MCP_TOOLS_TTL_MS`, default 60 s).
- A task chooses its servers with the `mcp` field (see the task API).
- HTTP management: `GET /v1/mcp/servers`, `PUT|DELETE /v1/mcp/servers/:name`,
  `POST /v1/mcp/servers/:name/{test,enable,disable}`,
  `GET /v1/mcp/servers/:name/tools`, `POST /v1/mcp/import`.

Details (all options, secrets, results, failure handling, security):
**[docs/MCP.md](docs/MCP.md)**.

## Docker

```bash
docker run -d --name wrongforge -p 8787:8787 -v wrongforge-data:/data \
  ghcr.io/wrongstack/wrongforge:latest
```

State lives in the `/data` volume (`WRONGFORGE_HOME`): OAuth tokens, the
generated API key, task/session stores, logs — mount it or you re-sign-in on
every restart. Images are published to GHCR on every release (`<version>` +
`latest`); inside a container the server runs from source under tsx and the
in-process self-update paths stay off by design — updating = pulling a newer
image. A `docker-compose.example.yml` ships in the repo (volume, restart
policy, `HOST=0.0.0.0`, allowed-roots mount example). Agents may only write
where the container can see: mount the directories you want them to work in
and pass `WRONGFORGE_ALLOWED_ROOTS`.

## WrongForge as an MCP server

The reverse direction: `wrongforge mcp-server` runs a **stdio MCP server**
that exposes the task API as tools — `submit_task` (with `wait: true` to
block until the agent finishes and return the result), `get_task`,
`wait_task`, `cancel_task`, `list_tasks`, `task_events`, `list_sessions` and
`usage_summary`. Any MCP client can drive WrongForge in natural language:

```bash
claude mcp add wrongforge -- wrongforge mcp-server
```

The bridge talks to a RUNNING WrongForge server over HTTP:
`WRONGFORGE_URL` (default `http://127.0.0.1:8787`) + `WRONGFORGE_API_KEY`
(default: the saved `<data dir>/api-key`). Whatever key the bridge holds
scopes its work — hand it a named client key (see TASKS-API.md → "Multiple
clients") and Claude's submissions land in that client's scope, subject to
its queue cap and fair share like any other orchestrator.

## Tool gateway

An orchestrator can lend the agent its own tools over HTTP. A task's `gateway`
object either points at a discovery endpoint (`GET {url}{list_path}` →
`{ tools: [{ name, description, input_schema }] }`) or passes definitions inline;
each call is `POST`ed back to `{url}{call_path}`. Tools appear to the model as
`<name_prefix><name>` (default `wstack_`), sorted so the tool list — part of the
prompt-cache prefix — stays byte-stable. Tokens and custom headers are kept in
memory only. Non-loopback gateway hosts must be listed in
`WRONGFORGE_GATEWAY_ALLOWED_HOSTS`. Full contract:
**[docs/TOOL-GATEWAY.md](docs/TOOL-GATEWAY.md)** (code: `src/tools/gateway.ts`).

## HTTP task API

`npm run serve` starts a local server (plain `node:http`) around the same agent
loop. An orchestrator submits a **task**; the agent works on it asynchronously
and emits numbered events that can be consumed live or replayed later.

```bash
# the key comes from AGENT_API_KEY, else ~/.wrongforge/api-key; if neither
# exists a strong key (wf_…) is generated, saved (0600) and shown in the banner
npm run serve                                          # http://127.0.0.1:8787

curl -N http://127.0.0.1:8787/v1/tasks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"prompt":"list the dependencies in package.json","workdir":"D:/work/app","stream":true}'
```

Submit modes (body flags of `POST /v1/tasks`): default → `202` + task document;
`"wait": true` → block until the task finishes; `"stream": true` → SSE stream
of this task's events. `"cancel_on_disconnect": true` cancels the task when the
client goes away.

| Endpoint | Purpose |
|---|---|
| `POST /v1/tasks` | submit a task (idempotent via client-chosen `task_id`) |
| `GET /v1/tasks` | list (`status`, `session_id`, `before`, `limit`) |
| `GET /v1/tasks/:id` | task document: status, progress, result, error |
| `GET /v1/tasks/:id/events` | events as JSON (`after`, `limit`, long-poll `wait_ms`) or SSE (`Accept: text/event-stream` / `?stream=1`, resumable with `Last-Event-ID`) |
| `POST /v1/tasks/:id/cancel` | cancel |
| `GET /v1/events` | live SSE feed of all tasks (`task_id`, `session_id` filters) |
| `GET/POST /v1/sessions`, `GET/DELETE /v1/sessions/:id`, `GET …/messages`, `POST …/compact` | sessions |
| `/v1/mcp/…` | MCP management (see above) |
| `GET /v1/usage` | plan usage (5-hour, weekly, extra), cached 5 min |
| `GET /v1/info`, `GET /v1/tools` | server capabilities and limits / tool list |
| `POST /v1/maintenance/run` | run housekeeping now |
| `GET /health` | unauthenticated (as is the optional dashboard shell, see below) |

**Task lifecycle:** `queued → running → completed | failed | cancelled | timed_out`.
Failures carry a machine-readable `error.code`: `agent_error`, `max_steps`,
`max_tokens`, `context_overflow`, `tool_gateway_unavailable`, `mcp_unavailable`,
`server_restarted`, `internal_error`. Tasks left running by a stopped server are
recovered at startup.

**Main submit fields:** `prompt` (required), `task_id`, `session_id`, `model`,
`max_steps` (1–500, default 50), `timeout_ms` (default 30 min), `workdir`
(required unless `WRONGFORGE_WORKDIR` is set; checked against
`WRONGFORGE_ALLOWED_ROOTS`), `workdir_lock`, `cache`, `env`, `system_append`,
`effort` (`low|medium|high|xhigh|max|off`), `context` (opaque, echoed back), `callback`,
`gateway`, `mcp`, `builtin_tools`
(allowlist of the built-in tools for this task, e.g. read-only ones so writes and
shell go through the orchestrator's gateway; omit = all; `/v1/info` lists
`features: ["builtin_tools", "effort"]`). The authoritative
list is `SubmitRequest` in `src/tasks/types.ts`.

**Events** (`seq` is per task, strictly increasing and gap-free; stored in
`events.jsonl`): `task.queued/started/heartbeat/completed/failed/cancelled/timed_out`,
`step.started/request/finished`, `tools.loaded`, `session.compacting/compacted`,
`context.cleared`, `agent.text/report/todos`, `tool.started/finished/failed`.
`step.request` carries what is about to be sent to the model for that step
(`model`, `effort`, `max_tokens`, `messages`, `tools`) — the request half of a
live traffic view; these events can be large.

**Dashboard (optional):** if a built web UI exists in `webui/dist` (it is not in
this repository snapshot), the server serves it at `/` (SPA fallback, traversal
refused) and prints a `dashboard:` line at startup; without it `/` shows a "not
built" hint. Only the static shell is public — data still needs the API key.
Since browsers cannot set headers on `EventSource`, `/v1/*` also accepts the key
as `?key=<key>` (request logs omit the query string); prefer the
`Authorization` header everywhere else.

**Webhooks:** with `callback: { url, events? }` events are POSTed with retries and
exponential backoff (`WRONGFORGE_WEBHOOK_MAX_ATTEMPTS`, default 6). Headers:
`X-WrongForge-Event`, `-Task`, `-Seq`, `-Delivery` (stable across retries),
`-Attempt`, `-Timestamp`, and `X-WrongForge-Signature: sha256=<hex>` =
HMAC-SHA256 over `"<timestamp>.<raw body>"`, keyed by `WRONGFORGE_WEBHOOK_SECRET`
or, if unset, the API key.

Concurrency: `WRONGFORGE_MAX_CONCURRENCY` tasks run at once (default 2); a task
with `workdir_lock` waits until no other task uses that directory. One session
runs one task at a time.

> **Security:** the agent can run shell commands and write files. The API key is
> mandatory, the server binds to `127.0.0.1` by default and request bodies are
> capped at 1 MB — but there is **no sandbox**. `workdir` sets where a task
> *starts*; it does not confine it (use `WRONGFORGE_ALLOWED_ROOTS` to restrict
> where tasks may start, and a container/VM for untrusted prompts).

Full reference: **[docs/TASKS-API.md](docs/TASKS-API.md)** (protocol) and
**[docs/INTEGRATION.md](docs/INTEGRATION.md)** (building a client: patterns,
examples, troubleshooting). Index: [docs/API.md](docs/API.md).

## Anthropic-compatible endpoint

The same server also mirrors the Anthropic Messages API itself. Any Anthropic
client — Claude Code, the official Node/Python SDKs, WrongStack, curl — can
point `ANTHROPIC_BASE_URL` at WrongForge and use the credentials the server
holds (the OAuth subscription, or its `ANTHROPIC_API_KEY`):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_API_KEY=$KEY          # the WrongForge server key (x-api-key or Bearer)

# e.g. Claude Code on the server's subscription:
ANTHROPIC_BASE_URL=http://127.0.0.1:8787 ANTHROPIC_API_KEY=$KEY claude
```

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Messages API — streaming and non-streaming, passed through 1:1 |
| `POST /v1/messages/count_tokens` | token counting |
| `GET /v1/models`, `GET /v1/models/:id` | model catalog |

Two upstream modes, chosen exactly like the agent's own requests
(code: `src/proxy.ts`):

- **OAuth (default):** requests ride the same Claude Code client signature the
  agent uses — Bearer token, the captured beta-header list and the body fields
  the subscription requires — so the plan serves them (without the costume the
  backend answers 400 "Third-party apps now draw from your extra usage").
  Streaming turns are sent with the CC `max_tokens` ceiling (128 000), 401s
  auto-refresh, the 400 self-heal applies. Client-sent `output_config.effort`
  and `cache_control` markers are preserved; missing cache breakpoints are
  added like on the agent's own requests.
- **`ANTHROPIC_API_KEY` set:** pure byte-for-byte passthrough — only the
  credential is swapped in, nothing is added to or removed from the body.

Responses pass through untouched: status, SSE events, rate-limit and
`anthropic-*` headers, error envelopes. The client's WrongForge key is never
forwarded upstream. `WRONGFORGE_PROXY=0` turns the surface off;
`WRONGFORGE_PROXY_MAX_BODY` caps request bodies (default 32 MB — the task
API's 1 MB is too small for long contexts and inline images).

**Watch it happen:** the dashboard's **Proxy** tab shows every call to this
surface live — method, model, `stream`/`auth_mode`, status, duration, and the
request/response bodies themselves (expandable). Each body's button shows a
human-readable summary by default (model, message/tool counts, the last
message's or reply's tool calls and text — reconstructed from the raw SSE
text for streaming calls too) rather than raw JSON; click it for the full
payload, unchanged. It is fed by its own `proxy.call` SSE channel
(`docs/TASKS-API.md`), separate from the task firehose. Bodies shown there
are a size-capped copy for display only (`WRONGFORGE_PROXY_TAP_BODY_CAP`,
default 8 KB) — truncation there never touches what the real client actually
exchanged.

## Sessions & context management

A session (`session_id`) keeps the conversation across tasks; it is persisted
under `~/.wrongforge/sessions/`. A long history is kept under control by:

1. **Per-result cap** — any single tool result bigger than
   `WRONGFORGE_MAX_TOOL_OUTPUT_CHARS` (default 400 000 chars, ~100K tokens) is
   clipped (middle cut, both ends kept) the moment it comes back, before it
   ever reaches the conversation — regardless of which tool produced it.
   Built-in tools already bound their own output (tens of thousands of
   chars); this is the backstop for MCP/gateway tools that don't, and for
   anything that slips through. Without it, one oversized result can push a
   request straight past the model's context window — the in-task guard
   below only reacts to the API's own usage numbers, which arrive one
   request too late to catch that.
2. **In-task guard** — once the live context passes `WRONGFORGE_CLEAR_AT`
   tokens (default 600 000), old tool outputs are replaced by a placeholder; the
   most recent `WRONGFORGE_KEEP_TOOL_RESULTS` (8) are kept. Checked both
   before every model call and right after a tool result is appended (using
   a same-turn size estimate of that result, so a single large result can't
   silently slip past the threshold before the next request).
3. **Between tasks** — a session whose context exceeds `WRONGFORGE_COMPACT_AT`
   (default 150 000) is summarized by the model; the last
   `WRONGFORGE_COMPACT_KEEP_TURNS` (2) turns stay verbatim and the originals are
   archived. Also available as `POST /v1/sessions/:id/compact`.

If a task still fails with `context_overflow` (the model rejected a prompt
that didn't fit even with all three defenses active), the session is flagged
and the *next* task on the same `session_id` compacts it automatically before
running.

**Prompt caching:** `cache_control` breakpoints are set on the last system block
and the last message, so every request reads what the previous one wrote.
Modes per task: `5m`, `1h` (default, `WRONGFORGE_CACHE`) or `off` — but only
on the turn that **creates** the session: Anthropic requires a consistent TTL
ordering across the whole cached prefix, and a later turn only ever marks the
newest message (older `cache_control` blocks already in history are never
touched), so a session's cache mode is **locked in by its first turn** and
every later task's `cache` request is silently overridden to match (a
`session.cache_mode_locked` event/log line notes it when that happens). If the
API still rejects `cache_control` (e.g. it's unsupported on the account) or
a session somehow ends up with an inconsistent TTL ordering anyway
(`cache_ordering_error`, recovered exactly like `context_overflow` — the
session is flagged and compacts on the next task), caching switches off for
*that session* — not the whole process, so one broken session never silently
disables caching for every other session this server is also handling.
`/v1/messages` retries once on `401` (after a token refresh); the SDK retries
transient errors twice.

**Reasoning effort:** effort-capable models get an `effort` field — `low`,
`medium` or `high` (default `high`, `WRONGFORGE_EFFORT`; `off` never sends
it). Which levels a model accepts depends on its family (`src/effort.ts`
keeps the table); a level the model lacks is clamped to the nearest one it
has, and models without effort support never receive the field. If the API
rejects the parameter for a model (verified live: the subscription backend
answers `effort: Extra inputs are not permitted` even for models this table
expects to accept it), the request is retried once without it and the field
is dropped for THAT model for the rest of the process — other models keep
their effort. Per task via the `effort` submit field, in the REPL via
`/effort`; `WRONGFORGE_EFFORT=off` skips the probe entirely.

**System prompt in task mode** = base prompt + a "worker for the orchestrator"
block + every `prompts/*.md` guide (dir: `WRONGFORGE_PROMPT_DIR`; files starting
with `_` and `README.md` are skipped; re-read for every task) + the task's
`system_append`. Per-task facts (id, cwd) go into the user message, never the
system prompt, to keep the cached prefix stable.

## Architecture

```
src/oauth.ts       OAuth (PKCE) login/refresh/import; AES-256-GCM token store
src/provider.ts    Anthropic client; oauthFetch injects Bearer + Claude Code client
                   signature, system blocks, cache breakpoints; refresh-on-401
src/agent.ts       runAgentTurn(): streams /v1/messages, runs tool_use blocks
                   locally, loops until the model stops or maxSteps is reached
src/proxy.ts       Anthropic-compatible proxy (/v1/messages, /v1/models) —
                   mirrors oauthFetch's client signature for proxied clients
src/tools/         bash read write edit ls glob grep web_fetch todo report mcp gateway
src/mcp/           MCP config store (mcp.json) + pooled client registry
src/tasks/         TaskManager (queue, lifecycle, recovery), TaskStore (disk),
                   webhook dispatcher, protocol types
src/sessions.ts    persistent sessions     src/compaction.ts   context guard + summaries
src/cache.ts       prompt-cache breakpoints  src/prompt.ts      task system prompt
src/effort.ts      model-aware reasoning effort (effort field per model family)
src/log.ts         JSONL logs (masking, rollover, gzip)   src/maintenance.ts  retention
src/app.ts         wires everything from env   src/apikey.ts  API key resolution
src/main.ts        CLI + REPL        src/server.ts     HTTP API (+ optional dashboard)
src/update.ts      release checks + self-update (prepare/install split)
src/supervisor.ts  crash-restart supervisor (WRONGFORGE_SUPERVISE=1)
src/mcp-cli.ts     MCP CLI
webui/             the dashboard itself: React 19 + Radix UI + React Flow (Vite);
                   `webui:build` compiles it to webui/dist, which server.ts serves at /
```

`runAgentTurn(client, model, history, maxSteps, abortSignal, onEvent?, system?, guard?, extraTools?)`:
without `onEvent` it prints to the terminal (REPL); with it, it emits structured
`AgentEvent`s (`step_start`, `step_finish`, `text`, `tool_call`, `tool_result`,
`tool_error`, `context_cleared`, `error`) which `TaskManager` turns into the
persisted task events above.

OAuth note: the token endpoint is `platform.claude.com/v1/oauth/token` (the
old `console.anthropic.com` URL now 404s) and it expects a **JSON** body with
the header `User-Agent: claude-cli/…` — a generic `anthropic` UA is what the
endpoint 429-rate-limits (probe-verified, see `re/notes/findings.md` §11);
the exchange body carries `state` as well. It is used only for `/v1/messages`,
`/v1/models` and the usage/bootstrap calls.

## Configuration

Environment variables (all optional unless noted):

| Variable | Meaning |
|---|---|
| `CLAUDE_MODEL` | Default model (default `claude-sonnet-5-5`) |
| `ANTHROPIC_API_KEY` | Use a console API key instead of OAuth (no Claude Code signature) |
| `CLAUDE_TOKEN_STORE` | Token file path |
| `ANTHROPIC_BASE_URL` | Different API root (proxy/mock). Also disables the bootstrap call |
| `ANTHROPIC_TOKEN_URL`, `CLAUDE_OAUTH_*`, `ANTHROPIC_AUTHORIZE_URL` | OAuth endpoints / client registration overrides (`CLIENT_ID`, `AUTHORIZE_URL`, `TOKEN_URL`, `REDIRECT_URI`, `SCOPE`); `CLAUDE_OAUTH_CONFIG` = config file path |
| `CLAUDE_CREDENTIALS_FILE` | Path of the Claude Code credentials file `import` reads (default `~/.claude/.credentials.json`) |
| `AGENT_API_KEY` | Server Bearer key (≥ 16 chars). Unset → saved/generated key |
| `AGENT_API_KEYS` | Extra named client keys `name=key,…` (or `<data dir>/api-keys.json`) — one per orchestrator; each client sees only its own tasks/sessions, the single key stays the admin `default` view. See TASKS-API.md → "Multiple clients" |
| `WRONGFORGE_MAX_QUEUED_PER_CLIENT` | Queue-flood guard: max QUEUED tasks per named client (default 50, 0 = unlimited; over the cap submits get `429 queue_full`; the default key is never capped) |
| `WRONGFORGE_CLIENT_RATE_LIMIT` | Per-client rate limit for the costing surfaces — task submit and proxy `/v1/messages*` — in requests/minute for named clients (default 120, 0 = unlimited; GETs are free; the default key is never limited). Over the limit: `429 rate_limited` with `Retry-After` |
| `WRONGFORGE_URL`, `WRONGFORGE_API_KEY` | What `wrongforge mcp-server` bridges to (server base URL, default `http://127.0.0.1:8787`; API key, default the saved `<data dir>/api-key`) |
| `PORT` / `HOST` | Server listen port (8787) / address (127.0.0.1) |
| `WRONGFORGE_PROXY` | Anthropic-compatible `/v1/messages` + `/v1/models` proxy surface (`0` disables; on by default) |
| `WRONGFORGE_PROXY_MAX_BODY` | Proxy request body cap in bytes (32 MB) |
| `WRONGFORGE_PROXY_TAP_BODY_CAP` | Dashboard "Proxy" tab's request/response body display cap in bytes (8 KB) — UI-only, independent of `WRONGFORGE_PROXY_MAX_BODY` |
| `WRONGFORGE_HOME` | Data directory (default `~/.wrongforge`) |
| `WRONGFORGE_LOG_DIR` / `_LOG_LEVEL` / `_LOG_STDERR` / `_LOG_MAX_MB` | Logging: dir, `debug\|info\|warn\|error`, mirror to stderr, daily-file size cap (50) |
| `WRONGFORGE_MAX_CONCURRENCY` | Tasks running at once (2) |
| `WRONGFORGE_WORKDIR` / `_ALLOWED_ROOTS` / `_WORKDIR_LOCK` | Default workdir; allowed start roots (`;` on Windows, `:` elsewhere); lock workdirs by default |
| `WRONGFORGE_TASK_TIMEOUT_MS` / `_HEARTBEAT_MS` | Default task timeout (30 min) / heartbeat interval (15 s) |
| `WRONGFORGE_TOKEN_KEEPALIVE_MS` | OAuth keep-alive check interval (5 min; `0` disables) — refreshes the session while the server idles so the token chain never goes stale |
| `WRONGFORGE_WEBHOOK_SECRET` / `_WEBHOOK_MAX_ATTEMPTS` | Webhook HMAC key (default: API key) / attempts (6) |
| `WRONGFORGE_CACHE` | Default cache mode `5m\|1h\|off` (1h) |
| `WRONGFORGE_EFFORT` | Default reasoning effort `low\|medium\|high\|off` (high), clamped to model support |
| `WRONGFORGE_LIVE` | Serve-console live view: every HTTP request and task event as a colored line on stdout. Auto in a terminal, `1` forces on (pipes/logs), `0` off |
| `WRONGFORGE_CONTEXT_WINDOW`, `_COMPACT_AT`, `_CLEAR_AT`, `_COMPACT_KEEP_TURNS`, `_KEEP_TOOL_RESULTS`, `_MAX_TOOL_OUTPUT_CHARS`, `_SUMMARY_MODEL` | Context management (see [Sessions & context management](#sessions--context-management)) |
| `WRONGFORGE_PROMPT_DIR` | Guide directory (default `<repo>/prompts`) |
| `WRONGFORGE_MCP_CONFIG`, `_MCP_IDLE_MS`, `_MCP_TOOLS_TTL_MS`, `_MCP_AGENT_MANAGE` | MCP config path, pool idle time, tool-list TTL, allow the agent to add/remove servers (1) |
| `WRONGFORGE_GATEWAY_ALLOWED_HOSTS`, `_GATEWAY_DISCOVERY_TTL_MS` | Non-loopback gateway hosts; discovery cache (30 s) |
| `WRONGFORGE_LOG_COMPRESS_AFTER_DAYS` / `_LOG_RETENTION_DAYS` / `_TASK_COMPRESS_AFTER_DAYS` / `_TASK_RETENTION_DAYS` / `_SESSION_RETENTION_DAYS` / `_MAINTENANCE_INTERVAL_MIN` | Housekeeping (defaults 1 / 30 / 3 / 90 / 0 = keep / 60; `0` disables a step) |
| `WRONGFORGE_AUTO_UPDATE` | `1` installs a newer release automatically once idle (compiled binary only; off by default — see [Releases](docs/RELEASE.md)) |
| `WRONGFORGE_AUTO_UPDATE_POLL_MS` | How often the idle+update-available condition is checked (2 min) |
| `WRONGFORGE_SUPERVISED_CHILD` | Set automatically on the supervisor's child process — never set it by hand |
| `WRONGFORGE_UPDATE_REPO` | Repo the update checks download from (default `WrongStack/WrongForge`; mainly for tests) |
| `WRONGFORGE_SUPERVISE` | `1` runs `serve` under a crash-restart supervisor with capped exponential backoff (off by default) |
| `WRONGFORGE_CC_RECOVERY` | `0` disables the automatic recovery that adopts a live Claude Code session when a token refresh fails |
| `WRONGFORGE_COUNT_TOKENS` | `0` disables the informational `count_tokens` preflight before streaming turns |
| `WRONGFORGE_ALLOW_PRIVATE_URLS` | `1` lets `web_fetch` reach private/loopback addresses (the SSRF guard is otherwise unconditional) |
| `WRONGFORGE_DEBUG` | `1` shows the full crash stack instead of the one-line message |
| `WRONGFORGE_MAX_RETRIES` | Client retries per model call when the backend answers 408/409/429/5xx (default 2, the SDK default; clamped 0–10 — every retry re-sends the whole prompt) |
| `NO_COLOR` | Plain startup banner |

## Data directory

Everything lives in `~/.wrongforge/` (or `$WRONGFORGE_HOME`):

| Path | Contents |
|---|---|
| `tokens.json` + key file | OAuth tokens, AES-256-GCM encrypted (key in a separate 0600 file) |
| `oauth.json` | OAuth client registration |
| `api-key` | HTTP API key (0600) |
| `user-id`, `account-uuid` | identifiers sent in `metadata.user_id` (see Privacy) |
| `mcp.json` | MCP server configuration (0600) |
| `sessions/` | persisted conversations (+ compaction archives) |
| `tasks/<id>/` | `task.json`, `events.jsonl` (gzip after a few days, removed after retention) |
| `logs/` | daily JSONL logs, secrets masked |

Housekeeping runs at server start and then hourly; `POST /v1/maintenance/run`
triggers it on demand. Live tasks, busy sessions and the active log are never
touched.

## Tests

```bash
npm test             # runs the suites below in sequence (stops at the first failure)
npm run typecheck    # strict tsc --noEmit
```

`npm test` covers: `tools` (bash, read/write/edit, ls, glob, grep, web_fetch
helpers, todos), `oauth-mock` (exchange, refresh, header injection, import),
`agent-e2e` (whole loop against a fake Anthropic SSE server with real local tool
execution), `tasks-core` (lifecycle, events, idempotency, replay, sessions,
cache-prefix stability, recovery), `tasks-concurrency` (parallel isolation,
queue, locks, cancel, timeout, allowed roots, webhooks), `log`, `apikey`, `mcp`,
plus `unit-core` (compaction, cache, messages, config, paths, banner, prompts,
usage, maintenance), `unit-net` (network-facing helpers), `unit-final` and `cli`
(REPL / entry points). No test talks to Anthropic.

> The former `test/server.test.ts` (removed `/v1/run` endpoint) was retired; its live-surface checks — auth, tools, sessions, prompt and JSON validation — live in `test/tasks-core.test.ts`.

## Security notes

- Tokens are stored AES-256-GCM encrypted in `~/.wrongforge/tokens.json` (key in
  a separate 0600 file) — a dependency-free equivalent of Electron safeStorage/DPAPI.
- `bash`, `write` and `edit` act on the user's machine with the user's rights.
  The system prompt asks the model to avoid destructive actions, but that is not
  a guarantee, and there is no per-command approval or sandbox.
- The HTTP API gives its key holder that same power. Keep it on loopback, keep
  the key secret (compared in constant time), and put TLS + a reverse proxy in
  front before exposing it. `/health` and the static dashboard shell are the only
  unauthenticated routes; every `/v1/*` route needs the key.
- `web_fetch` refuses non-public addresses and embedded credentials, but it
  resolves DNS separately from the request, so it is not hardened against DNS
  rebinding. (`WRONGFORGE_ALLOW_PRIVATE_URLS=1` lifts the private-address
  guard entirely — only for networks where that is the point.)
- Gateway tokens/headers and task `env` values are never persisted (only their
  names are); logs mask secrets.
- User-driven mutations (task submit/cancel, session create/delete/compact,
  MCP server config changes) land in an append-only audit trail
  (`<data dir>/audit.jsonl`, prompts excluded), readable via
  `GET /v1/audit` with the admin key.
- Named client keys (`AGENT_API_KEYS` / `api-keys.json`) scope tasks, sessions
  and event feeds to their own work — but every key holder can drive the same
  subscription and OAuth session, so hand keys out only to orchestrators you
  trust with the plan itself.

## Known limitations

- The login flow uses a public OAuth client registration supplied via config
  (see `oauth.config.example.json`); if the registration changes (scope/
  redirect), update your config — nothing is hardcoded.
- Subscription (OAuth) access relies on Claude Code client emulation and may
  stop working without notice — see the privacy section; use `ANTHROPIC_API_KEY`
  for a supported path.
- No sandbox, no per-command approval; tool calls within a step run sequentially.
- `src/app.ts` and `src/maintenance.ts` mention `npm run maintain`; that script is
  not defined in `package.json` (use `POST /v1/maintenance/run` or run the server).

## License

MIT — see [LICENSE](LICENSE). © WrongStack. The license's
"THE SOFTWARE IS PROVIDED AS IS…" clause is the whole deal: this project is
**experimental**, maintained on a best-effort basis, and carries no support
obligations or liability of any kind.
