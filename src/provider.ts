/**
 * Wires the official Anthropic SDK client to OAuth tokens.
 *
 * Signing scheme (same as Claude Code):
 *   Authorization: Bearer <oauth-token>
 *   anthropic-beta: oauth-2025-04-20        (required for OAuth tokens)
 *   anthropic-version: 2023-06-01           (sent by the provider itself)
 *   User-Agent: claude-cli/<v> (external, cli)  +  x-app: cli
 *
 * The subscription backend serves OAuth tokens only to Claude Code-style
 * clients; without these client headers /v1/messages returns a bare
 * rate_limit_error ("message":"Error") even when the token is valid.
 * The UA string is app-level metadata — it contains nothing machine-specific.
 *
 * A placeholder apiKey is passed and the custom fetch strips the provider's
 * x-api-key, then injects the OAuth headers. On 401 it refreshes once and
 * retries.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClaudeOAuth } from "./oauth.js";
import { CLAUDE_CODE_UA, PROTOCOL } from "./oauth.js";
import { applyCacheBreakpoints, defaultCacheMode, type CacheMode } from "./cache.js";
import {
  EFFORTS,
  applyEffortToBody,
  effectiveEffort,
  effortRejectedOnce,
  isEffort,
  lowerEffort,
  markEffortRejected,
  noteEffortCap,
  resolveEffort,
  type Effort,
} from "./effort.js";

import { currentContext } from "./context.js";
import { dataDir } from "./paths.js";

/**
 * Mimics the Claude Code CLI client signature (the user-agent itself lives in
 * oauth.ts next to the other shared protocol constants). Captured verbatim
 * from a real Claude Code request (values are app/runtime-class metadata:
 * nothing here is unique to this machine or persisted between runs).
 */
const SESSION_ID = crypto.randomUUID(); // fresh per app run, never stored

// ---------------------------------------------------------------- metadata id

/**
 * metadata.user_id in the shape real Claude Code sends (captured live, see
 * re/notes/findings.md §9): a JSON string with a persistent 64-hex device_id,
 * the account_uuid (fetched once from the bootstrap endpoint and cached next
 * to it) and the per-process session id. Falls back to the bare device id
 * when the account uuid is unavailable — the field is metadata, never fatal.
 */
let cachedAccountUuid: string | null = null;

function deviceId(): string {
  const file = path.join(dataDir(), "user-id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    /* first run — create it below */
  }
  const id = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file, id + "\n", { mode: 0o600 });
  return id;
}

/** One bootstrap fetch per process — returns the account uuid or null. */
async function fetchBootstrap(oauth: ClaudeOAuth): Promise<string | null> {
  if (process.env.ANTHROPIC_BASE_URL) return null; // test/proxy mode: never touch the real API
  try {
    const token = await oauth.getAccessToken();
    const res = await globalThis.fetch("https://api.anthropic.com/api/claude_cli/bootstrap", {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": CLAUDE_CODE_UA,
        "x-app": "cli",
        "x-claude-code-session-id": SESSION_ID,
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "anthropic-version": PROTOCOL.anthropicVersion,
      },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const uuid = (await res.json())?.oauth_account?.account_uuid;
      if (typeof uuid === "string" && uuid) {
        const file = path.join(dataDir(), "account-uuid");
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(file, uuid + "\n", { mode: 0o600 });
        return uuid;
      }
    }
  } catch {
    /* bootstrap is best-effort — sessions never fail because of it */
  }
  return null;
}

/**
 * Claude Code calls GET /api/claude_cli/bootstrap at EVERY startup (fresh
 * each process, never disk-cached — re/notes/findings.md §5); we mirror that
 * when the OAuth client is created, which also keeps the cached account uuid
 * current for metadata.user_id.
 */
let bootstrappedOnce = false;
export async function bootstrapSession(oauth: ClaudeOAuth): Promise<void> {
  if (bootstrappedOnce) return;
  bootstrappedOnce = true;
  await helloPing();
  const uuid = await fetchBootstrap(oauth);
  if (uuid) cachedAccountUuid = uuid;
}

/**
 * The startup liveness ping every CC run makes (captured: plain GET, Bun UA,
 * no auth). Mirrored for shape fidelity; the answer is ignored. Skipped in
 * test/proxy mode (ANTHROPIC_BASE_URL).
 */
async function helloPing(): Promise<void> {
  if (process.env.ANTHROPIC_BASE_URL) return;
  try {
    await globalThis.fetch("https://api.anthropic.com/api/hello", {
      headers: { "User-Agent": "Bun/1.4.3", Accept: "*/*" },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* liveness only */
  }
}

async function accountUuid(oauth: ClaudeOAuth): Promise<string | null> {
  if (cachedAccountUuid) return cachedAccountUuid;
  const file = path.join(dataDir(), "account-uuid");
  try {
    const cached = fs.readFileSync(file, "utf8").trim();
    if (cached) {
      cachedAccountUuid = cached;
      return cached;
    }
  } catch {
    /* not cached yet */
  }
  const uuid = await fetchBootstrap(oauth);
  if (uuid) cachedAccountUuid = uuid;
  return uuid;
}

async function claudeMetadataUserId(oauth: ClaudeOAuth): Promise<string> {
  const device = deviceId();
  const account = await accountUuid(oauth);
  if (!account) return device;
  return JSON.stringify({ device_id: device, account_uuid: account, session_id: SESSION_ID });
}

/**
 * Client retries per model call (the SDK's). A busy backend answers
 * 503/529 "model busy" and the SDK walks these attempts silently (see the
 * retry-visibility report in oauthFetch); WRONGFORGE_MAX_RETRIES raises or
 * lowers the budget. Default 2 (the SDK default), clamped to 0-10 — every
 * retry re-sends the whole prompt, so more is not free.
 */
export function maxRetriesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WRONGFORGE_MAX_RETRIES;
  if (raw === undefined || raw === "") return 2;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  return Math.min(10, Math.max(0, Math.floor(n)));
}

function applyClientSignature(headers: Headers): void {
  headers.set("user-agent", CLAUDE_CODE_UA);
  headers.set("x-app", "cli");
  headers.set("x-claude-code-session-id", SESSION_ID);
  headers.set("anthropic-dangerous-direct-browser-access", "true");
  headers.set("x-stainless-lang", "js");
  headers.set("x-stainless-os", process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux");
  headers.set("x-stainless-arch", process.arch === "x64" ? "x64" : process.arch);
  headers.set("x-stainless-runtime", "node");
  // CC 2.1.300 presents itself as node v26.3.0 regardless of the runtime
  // beneath it (captured live) — pin the trio UA + sdk 0.128.0 + node 26.3.0
  headers.set("x-stainless-runtime-version", "v26.3.0");
  headers.set("x-stainless-package-version", "0.128.0");
  // the SDK maintains this one on its own retries — keep its value
  if (!headers.has("x-stainless-retry-count")) headers.set("x-stainless-retry-count", "0");
}

/**
 * Betas sent on every /v1/messages request — the EXACT list, in the exact
 * order, of captured CC 2.1.300 traffic (re/notes/cc-capture.jsonl). The
 * earlier minimal set worked, but a subset is itself a fingerprint; sending
 * precisely what the real client sends leaves nothing to diff. Verified
 * live: without context-management + dangerous-tool-use the backend answers
 * 400 "Third-party apps now draw from your extra usage"; the others ride
 * along (leave-one-out tested 2026-10-15).
 */
const CLAUDE_CODE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "inline-tools-2026-09-15",
  "advisor-tool-2026-03-01",
  "advanced-tool-use-2025-11-20",
  "effort-2025-11-24",
  "dangerous-tool-use-2026-09-03",
  "afk-mode-2026-01-31",
  "extended-cache-ttl-2025-04-11",
];

/**
 * Beta flag names that contain "ttl". They are part of the `anthropic-beta`
 * header we send, not of the request body, so they must never count as
 * evidence when classifying a 400 (see the cache self-heal below).
 */
const TTL_BETA_NAMES = CLAUDE_CODE_BETAS.filter((b) => /ttl/i.test(b));

/** The count_tokens preflight carries a smaller, fixed beta set (captured). */
const COUNT_TOKENS_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "token-counting-2024-11-01",
];

/**
 * The system prompt of a real Claude Code request starts with TWO fixed
 * blocks (captured live from CC 2.1.300, re/notes/cc-capture.jsonl):
 *
 *   1. a billing marker — "x-anthropic-billing-header: cc_version=…;
 *      cc_entrypoint=…;" — which is how the subscription backend classifies
 *      the traffic as first-party Claude Code for PLAN billing (the
 *      "Third-party apps … extra usage" 400 is what you get without it);
 *   2. the agent identity line of the entrypoint.
 *
 * Our own prompt follows as the next block. Cache breakpoints sit on the
 * blocks AFTER the billing header (as in the capture), which cache.ts
 * handles by marking the last system block.
 */
const CC_BILLING_HEADER_BLOCK =
  "x-anthropic-billing-header: cc_version=2.1.300.bc2; cc_entrypoint=sdk-cli;";
const CC_AGENT_IDENTITY_BLOCK =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Sessions whose cache_control was rejected once: caching is then switched
 * off for the REST OF THAT SESSION so a cache problem can never fail its
 * tasks again. Scoped per session, not process-wide — a single session with
 * a pre-existing problem (e.g. an inconsistent TTL ordering baked into its
 * history before this was fixed) must not silently disable caching for
 * every other session this process is also serving. Sessionless callers
 * (the REPL/chat path has no session_id) fall back to the one process-wide
 * flag below, matching the previous behavior there.
 */
const cacheRejectedSessions = new Set<string>();
let cacheRejectedGlobal = false;

/** Cache mode for the request being built: task override > env default; "off" after a rejection. */
function effectiveCacheMode(): CacheMode {
  const sessionId = currentContext()?.sessionId;
  const rejected = sessionId ? cacheRejectedSessions.has(sessionId) : cacheRejectedGlobal;
  if (rejected) return "off";
  return currentContext()?.cache ?? defaultCacheMode();
}

function withClaudeCodeSystem(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { input: RequestInfo | URL; init: RequestInit | undefined } {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.includes("/v1/messages") || typeof init?.body !== "string") {
    return { input, init };
  }
  try {
    const body = JSON.parse(init.body);
    const ccBlocks = [
      { type: "text", text: CC_BILLING_HEADER_BLOCK },
      { type: "text", text: CC_AGENT_IDENTITY_BLOCK },
    ];
    if (Array.isArray(body.system)) {
      // any billing marker — ours, another Claude Code version's, or one a
      // chained proxy already added — means the costume is on; never stack
      // a second block on top of it
      const first = String(body.system[0]?.text ?? "");
      if (!first.startsWith("x-anthropic-billing-header:")) {
        body.system = [...ccBlocks, ...body.system];
      }
    } else if (typeof body.system === "string") {
      body.system = [...ccBlocks, { type: "text", text: body.system }];
    } else {
      body.system = ccBlocks;
    }
    // Note: /v1/messages rejects a body-level anthropic_beta field ("extra
    // inputs are not permitted", verified live) — betas travel via the header
    // only on this endpoint.
    applyCacheBreakpoints(body, effectiveCacheMode());
    // Reasoning effort, model-aware: only sent when the model's family accepts
    // it (see effort.ts). Same position in every request, so the cached prefix
    // (tools -> system -> messages) is unaffected.
    applyEffortToBody(body, effectiveEffort(String(body.model ?? "")));
    applyClaudeCodeRequestShape(body);
    return { input, init: { ...init, body: JSON.stringify(body) } };
  } catch {
    return { input, init };
  }
}

function withBetaFlag(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string" && input.includes("/v1/messages") && !input.includes("beta=")) {
    return input + (input.includes("?") ? "&" : "?") + "beta=true";
  }
  return input;
}

// ------------------------------------------- CC request shape (captured 2.1.300)
// Body fields a real Claude Code /v1/messages call carries that we did not
// send (all verified in re/notes/cc-capture.jsonl): adaptive thinking, the
// context-management edit list, the dangerous-tool-use safeguards block, and
// max_tokens=128000 on main (streaming) turns. Each is dropped individually
// by the 400 self-heal below when an endpoint refuses it.

let thinkingRejected = false;
let contextManagementRejected = false;
let safeguardsRejected = false;

/** C:\Users\x → /c/Users/x — the POSIX-style paths the captured body uses. */
function posixPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
}

function applyClaudeCodeRequestShape(body: any): void {
  if (!body || typeof body !== "object") return;
  if (!thinkingRejected && body.thinking === undefined) {
    body.thinking = { type: "adaptive", display: "omitted" };
  }
  if (!contextManagementRejected && body.context_management === undefined) {
    body.context_management = { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
  }
  if (!safeguardsRejected && body.safeguards === undefined) {
    body.safeguards = [dangerousToolUseSafeguard()];
  }
  // main turns: CC asks for the model ceiling (128k), not a mid value
  if (body.stream === true && typeof body.max_tokens === "number" && body.max_tokens < 128_000) {
    body.max_tokens = 128_000;
  }
}

/** The classifier context CC sends with the dangerous-tool-use beta. */
function dangerousToolUseSafeguard(): unknown {
  const cwd = posixPath(currentContext()?.cwd ?? process.cwd());
  const home = posixPath(os.homedir());
  return {
    type: "dangerous_tool_use",
    classifier_context: {
      v: 1,
      permission_mode: "auto",
      platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
      live_cwd: cwd,
      home_dir: home,
      rule_roots: {
        userSettings: `${home}/.claude`,
        projectSettings: cwd,
        localSettings: cwd,
        flagSettings: cwd,
        policySettings: cwd,
        cliArg: cwd,
        command: cwd,
        session: cwd,
        toolsNarrowing: cwd,
        mcpServerPolicy: cwd,
        hostCredential: cwd,
      },
      trusted_directories: {
        primary: { path: cwd, resolved: [cwd] },
        additional: [],
        network: [],
        block_reads_outside_working_directories: false,
      },
      rules: { allow: [], deny: [], ask: [] },
      auto_mode: { allow: [], soft_deny: [], hard_deny: [], environment: [] },
      artifact_consent_holdback: true,
      case_insensitive_paths: process.platform === "win32",
      restricted: false,
      is_remote_mode: false,
      classify_all_shell: false,
      user_identity: os.userInfo().username,
      git_state: {
        cwd,
        root: null,
        branch: null,
        default_branch: null,
        status: null,
        visibility: { origin: null, push_remote: null, remotes: [], visibility_cache: [] },
        error: "not_a_repo",
      },
    },
  };
}

/**
 * The count_tokens preflight CC issues before every main turn (captured 1:1
 * with /v1/messages): {model, messages, tools} with its own smaller beta
 * set. Best-effort — the count is informational, failures are ignored.
 * WRONGFORGE_COUNT_TOKENS=0 disables.
 */
async function countTokensPreflight(
  oauth: ClaudeOAuth,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  if (process.env.WRONGFORGE_COUNT_TOKENS === "0") return;
  if (process.env.ANTHROPIC_BASE_URL) return; // test/proxy mode: never touch the real API
  if (typeof body.model !== "string") return;
  try {
    await globalThis.fetch("https://api.anthropic.com/v1/messages/count_tokens?beta=true", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": CLAUDE_CODE_UA,
        "x-app": "cli",
        "x-claude-code-session-id": SESSION_ID,
        "anthropic-beta": COUNT_TOKENS_BETAS.join(","),
        "anthropic-version": PROTOCOL.anthropicVersion,
      },
      body: JSON.stringify({ model: body.model, messages: body.messages, tools: body.tools }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* informational only */
  }
}

export function oauthFetch(oauth: ClaudeOAuth): typeof globalThis.fetch {
  return async (input, init) => {
    const doFetch = async (): Promise<Response> => {
      const token = await oauth.getAccessToken();
      const headers = new Headers(init?.headers);
      headers.delete("x-api-key"); // auth is owned by this layer
      headers.set("authorization", `Bearer ${token}`);
      if (!headers.has("anthropic-version")) {
        headers.set("anthropic-version", PROTOCOL.anthropicVersion);
      }
      const flags = new Set(
        (headers.get("anthropic-beta") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      for (const b of CLAUDE_CODE_BETAS) flags.add(b);
      headers.set("anthropic-beta", [...flags].join(","));
      applyClientSignature(headers);
      const routed = withClaudeCodeSystem(input, init);
      // Claude Code carries metadata.user_id on every messages request; the
      // agent layer leaves it unset and it is injected here, once per process
      // (the account uuid lookup is cached).
      let routedInit = routed.init;
      if (typeof routed.input === "string" && routed.input.includes("/v1/messages") && !routed.input.includes("count_tokens") && typeof routedInit?.body === "string") {
        try {
          const body = JSON.parse(routedInit.body);
          body.metadata ??= {};
          if (typeof body.metadata.user_id !== "string") {
            body.metadata.user_id = await claudeMetadataUserId(oauth);
            routedInit = { ...routedInit, body: JSON.stringify(body) };
          }
          // main (streaming) turns: CC counts tokens first, 1:1 (captured)
          if (body.stream === true) await countTokensPreflight(oauth, token, body);
        } catch {
          /* not a JSON body — leave untouched */
        }
      }
      return globalThis.fetch(withBetaFlag(routed.input), {
        ...routedInit,
        headers,
      });
    };

    let res = await doFetch();
    if (res.status === 401) {
      const fresh = await oauth.refresh();
      if (fresh) res = await doFetch();
    }
    // The API refused our cache_control markers (e.g. unsupported TTL on this
    // account): retry once without them and stop sending them.
    if (res.status === 400 && effectiveCacheMode() !== "off") {
      const detail = await res.clone().text().catch(() => "");
      if (/cache_control|cache control|ttl/i.test(TTL_BETA_NAMES.reduce((t, b) => t.split(b).join(""), detail))) {
        const sessionId = currentContext()?.sessionId;
        if (sessionId) cacheRejectedSessions.add(sessionId);
        else cacheRejectedGlobal = true;
        console.error(`[cache] the API rejected cache_control — prompt caching is disabled for ${sessionId ? `session ${sessionId}` : "this process"}:`, detail.slice(0, 300));
        res = await doFetch();
      }
    }
    // The API refused the effort parameter. Two shapes (both retried within
    // this one caller-visible request, so the caller only ever sees success):
    //  - "Invalid effort level" (an org-admin CAPS a model's effort, revealed
    //    by CC 2.1.314 — findings.md §21): the parameter itself is fine, the
    //    LEVEL is above the account ceiling → step down one level per retry,
    //    learning the working level as a per-model cap (effort.ts's
    //    effectiveEffort then clamps every later request directly). Bounded
    //    by the 5-level ladder; if even the bottom level is refused, fall
    //    through to the off-path below.
    //  - anything else (e.g. "Extra inputs are not permitted" — a model that
    //    does not accept the parameter at all): retry once WITHOUT it and
    //    stop sending it for THAT model, so other models keep their effort.
    if (res.status === 400 && !effortRejectedOnce()) {
      let detail = await res.clone().text().catch(() => "");
      if (/effort/i.test(detail)) {
        let model = "";
        let clientLevel: Effort | null = null; // a level the CALLER put in the body itself
        try {
          const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: unknown; output_config?: { effort?: unknown } | undefined }) : null;
          if (typeof body?.model === "string" && body.model) model = body.model;
          if (isEffort(body?.output_config?.effort)) clientLevel = body.output_config.effort as Effort;
        } catch {
          /* keep "" — the global fallback below */
        }
        if (/invalid effort level/i.test(detail) && model) {
          let sent = clientLevel ?? resolveEffort(effectiveEffort(model), model).effort;
          let guard = 0;
          while (res.status === 400 && sent && guard++ < EFFORTS.length) {
            const lower = lowerEffort(sent);
            if (!lower) break; // even the bottom level is capped
            noteEffortCap(model, lower);
            console.warn(`[effort] ${model}: level ${sent} rejected (account cap) — stepping down to ${lower} (remembered 7d)`);
            if (clientLevel && typeof init?.body === "string") {
              // a caller-owned body value wins applyEffortToBody's re-apply,
              // so the step-down has to rewrite the body itself
              const b = JSON.parse(init.body) as { output_config?: { effort?: unknown } };
              b.output_config = { ...(b.output_config ?? {}), effort: lower };
              init = { ...init, body: JSON.stringify(b) };
            }
            res = await doFetch(); // withClaudeCodeSystem re-applies effort from effectiveEffort → now the cap
            sent = lower;
            if (res.status === 400) detail = await res.clone().text().catch(() => "");
            if (!/invalid effort level/i.test(detail)) break;
          }
        }
        if (res.status === 400 && /effort/i.test(detail)) {
          markEffortRejected(model || undefined);
          // informational only — the retry below is what the caller sees, and
          // the learned rejection is remembered across restarts (effort.ts)
          console.warn(
            `[effort] ${model || "this backend"} does not accept the effort parameter — retried without it; effort is off for ${model || "all models"} (remembered 7d)`,
          );
          res = await doFetch();
        }
      }
    }
    // Same self-healing for the captured request-shape fields (thinking /
    // context_management / safeguards): drop whichever the endpoint names,
    // retry once, and stop sending it for this process.
    if (res.status === 400 && (!thinkingRejected || !contextManagementRejected || !safeguardsRejected)) {
      const detail = await res.clone().text().catch(() => "");
      const named: string[] = [];
      if (!thinkingRejected && /thinking/i.test(detail)) named.push("thinking");
      if (!contextManagementRejected && /context_management/i.test(detail)) named.push("context_management");
      if (!safeguardsRejected && /safeguards/i.test(detail)) named.push("safeguards");
      if (named.length) {
        if (named.includes("thinking")) thinkingRejected = true;
        if (named.includes("context_management")) contextManagementRejected = true;
        if (named.includes("safeguards")) safeguardsRejected = true;
        console.warn(`[shape] ${named.join(", ")} not accepted — retried without it; off for this process`);
        res = await doFetch();
      }
    }
    // Upstream retry visibility (issue #7 follow-up): for retryable statuses
    // (408/409/429/5xx) the SDK retries silently, so a busy backend can leave
    // a RUNNING task without a single event for minutes — the exact silence
    // korlog's report showed beside the queue starvation. Say what is going on
    // while it happens; the SDK's x-stainless-retry-count header (defaulted to
    // "0" inside doFetch) tells us which attempt this response belongs to.
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (
      currentContext()?.report &&
      url.includes("/v1/messages") &&
      !url.includes("count_tokens") &&
      (res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500)
    ) {
      const attempt = Number(new Headers(init?.headers).get("x-stainless-retry-count") ?? 0);
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `; server asked to wait ${retryAfter}s` : "";
      const left = Math.max(0, maxRetriesFromEnv() - attempt); // the same budget createClaudeClient hands the SDK
      currentContext()!.report!({
        phase: "retry",
        message:
          left > 0
            ? `upstream ${res.status}${wait} — the client retries on its own (${left} left), the task stays running`
            : `upstream ${res.status}${wait} — client retries exhausted; this model call fails`,
      });
    }
    return res;
  };
}

/**
 * This SDK version's default base URL is the bare origin ("https://
 * api.anthropic.com") and resource paths carry "/v1" themselves. The env
 * variable has historically been written both with and without "/v1" — strip
 * a trailing version segment so either form keeps working (tests, proxies).
 */
function normalizeBaseURL(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "").replace(/\/v\d+$/, "");
}

export function createClaudeClient(oauth: ClaudeOAuth): Anthropic {
  // Pay-as-you-go fallback: with a real console API key (console.anthropic.com
  // → API Keys) the OAuth/impersonation path is bypassed entirely — requests
  // bill to the key's credits, never to the subscription. /models still uses
  // the OAuth token regardless.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new Anthropic({
      apiKey,
      maxRetries: maxRetriesFromEnv(),
      baseURL: normalizeBaseURL(process.env.ANTHROPIC_BASE_URL),
    });
  }
  // Claude Code checks in with the bootstrap endpoint at every startup; the
  // fire-and-forget call also refreshes the cached account uuid.
  void bootstrapSession(oauth);
  return new Anthropic({
    apiKey: "managed-by-oauth", // the real credential is injected by oauthFetch
    fetch: oauthFetch(oauth),
    maxRetries: maxRetriesFromEnv(),
    // mock server for tests; defaults to api.anthropic.com in production
    baseURL: normalizeBaseURL(process.env.ANTHROPIC_BASE_URL),
  });
}
