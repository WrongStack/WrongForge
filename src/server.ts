/**
 * WrongForge HTTP API — the channel between an orchestrator (WrongStack) and
 * the worker agent. Full reference: docs/TASKS-API.md
 *
 *   POST   /v1/tasks                       submit a task (async; or wait / stream)
 *   GET    /v1/tasks                       list tasks
 *   GET    /v1/tasks/:id                   status + progress + result
 *   GET    /v1/tasks/:id/events            event log (JSON, long-poll, or SSE with replay)
 *   POST   /v1/tasks/:id/cancel            cancel
 *   GET    /v1/events                      live SSE feed (scoped per client key)
 *   *      /v1/sessions…                   durable conversations (+ compact)
 *   *      /v1/mcp/servers…                MCP server configuration
 *   POST   /v1/maintenance/run             log/task/session housekeeping now
 *   *      /v1/messages, /v1/models       Anthropic-compatible proxy (src/proxy.ts)
 *   GET    /v1/info, /v1/tools, /health
 *
 * Auth: `Authorization: Bearer <API key>` (or `x-api-key`, as Anthropic
 * clients send it) on everything except /health.
 * Errors: { "error": { "code": "...", "message": "..." } }
 */

import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeOAuth } from "./oauth.js";
import { createApp, type App } from "./app.js";
import { fetchPlanUsage } from "./usage.js";
import { agentTools } from "./tools/index.js";
import { DEFAULT_MODEL, KNOWN_MODELS } from "./agent.js";
import { effortSupport } from "./effort.js";
import { APP_NAME, VERSION, dataDir } from "./paths.js";
import { clientKeysFile, resolveApiKey, resolveClientKeys } from "./apikey.js";
import { createProxyHandler, proxyEnabled, proxyMaxBody, type ProxyCallEvent } from "./proxy.js";
import { printBanner } from "./banner.js";
import { loadPromptFiles } from "./prompt.js";
import { SubmitError } from "./tasks/manager.js";
import { isTerminal, type SubmitRequest, type TaskEvent, type TaskStatus } from "./tasks/types.js";
import { runMaintenance, startMaintenance } from "./maintenance.js";
import { McpConfigError } from "./mcp/config.js";
import { McpError } from "./mcp/registry.js";
import { SessionStore } from "./sessions.js";
import { startLiveView } from "./liveview.js";
import { checkForUpdate, cleanupOldBinary, installUpdate, isCompiledBinary, lastUpdateCheck, prepareUpdate, UPDATE_REPO } from "./update.js";

const MAX_BODY = 1_000_000;
const TERMINAL_EVENTS = new Set(["task.completed", "task.failed", "task.cancelled", "task.timed_out"]);
const ALL_STATUSES: TaskStatus[] = ["queued", "running", "completed", "failed", "cancelled", "timed_out"];

/**
 * Live HTTP-traffic frame for the dashboard's global SSE feed: what hits the
 * API right now, method/path/status/duration. Fire-and-forget — never
 * persisted, never part of the task event protocol.
 */
export interface HttpTapEvent {
  type: "http.request";
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerOptions {
  apiKey: string;
  /** Extra named client keys (key -> client name, "default" included). Absent = single-key install. */
  clientKeys?: Map<string, string>;
  oauth: ClaudeOAuth;
  app: App;
  /** Override the tool-guide directory shown in /v1/info (tests). */
  promptDir?: string;
  /** Built dashboard directory to serve at "/" (default: <repo>/webui/dist). */
  webuiDir?: string;
}

  /** Where `npm run webui:build` drops the dashboard (next to src/, not cwd). */
  const DEFAULT_WEBUI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "webui", "dist");

  /**
   * The dashboard embedded in the compiled binary (src/embedded-webui.ts,
   * packed by `npm run build:binary`). Empty in a source checkout — the stub
   * exists only so this module loads without webui/dist.
   */
  let embeddedWebuiPromise: Promise<Record<string, string>> | null = null;
  const embeddedWebui = (): Promise<Record<string, string>> => {
    embeddedWebuiPromise ??= import("./embedded-webui.js")
      .then((m) => m.EMBEDDED_WEBUI as Record<string, string>)
      .catch(() => ({}));
    return embeddedWebuiPromise;
  };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const NOT_BUILT_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>WrongForge dashboard</title>
<style>body{background:#0b0e14;color:#c9d4e3;font:14px/1.6 ui-monospace,Consolas,monospace;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
div{max-width:34rem;padding:2rem}h1{color:#7aa2f7;font-size:1.1rem;margin:0 0 .8rem}code{color:#9ece6a}</style></head>
<body><div>
<h1>WrongForge dashboard — not built yet</h1>
<p>The API is running (see <code>/v1/info</code>), but the web UI bundle is missing.
Build it once:</p>
<p><code>npm run webui:build</code></p>
<p>then reload this page. For live development: <code>npm run webui</code>.</p>
</div></body></html>`;

export function createAgentServer(opts: ServerOptions): http.Server {
  const { app, oauth } = opts;
  const manager = app.manager;
  const webuiDir = opts.webuiDir ?? DEFAULT_WEBUI_DIR;
  // key -> client name; the default key ALWAYS maps to "default" (the admin
  // view), merged in no matter what the caller passed. Missing map = single-key install.
  const clientKeys = new Map<string, string>(opts.clientKeys ? [[opts.apiKey, "default"], ...opts.clientKeys] : [[opts.apiKey, "default"]]);
  const keyBuffers = [...clientKeys.keys()].map((k) => Buffer.from(k));

  const webuiBuilt = (): boolean => {
    try {
      return fs.statSync(path.join(webuiDir, "index.html")).isFile();
    } catch {
      return false;
    }
  };

  /** Subscribers of the live HTTP-traffic view (the global SSE feed). */
  const httpTaps = new Set<(e: HttpTapEvent) => void>();
  /**
   * Recent traffic, kept in memory only (never persisted): replayed to every
   * new /v1/events subscriber so a freshly opened dashboard immediately sees
   * what hit the API while it was closed — live-only taps would otherwise
   * make past traffic invisible ("requests came but the feed looks empty").
   */
  const httpTapLog: HttpTapEvent[] = [];
  const HTTP_TAP_LOG_CAP = 300;
  const recordTap = (e: HttpTapEvent): void => {
    httpTapLog.push(e);
    if (httpTapLog.length > HTTP_TAP_LOG_CAP) httpTapLog.splice(0, httpTapLog.length - HTTP_TAP_LOG_CAP);
    for (const t of httpTaps) t(e);
  };

  /**
   * Second, parallel tap channel for the dashboard's "Proxy" tab: full
   * request/response bodies for /v1/messages-surface calls (src/proxy.ts),
   * broadcast through the same /v1/events feed. Kept separate from
   * httpTaps/httpTapLog above (lighter, header-only) so a heavier, rarer
   * payload never bloats the hot-path HTTP tap or its backlog replay.
   */
  const proxyTaps = new Set<(e: ProxyCallEvent) => void>();
  const proxyTapLog: ProxyCallEvent[] = [];
  const PROXY_TAP_LOG_CAP = 150;
  const recordProxyTap = (e: ProxyCallEvent): void => {
    proxyTapLog.push(e);
    if (proxyTapLog.length > PROXY_TAP_LOG_CAP) proxyTapLog.splice(0, proxyTapLog.length - PROXY_TAP_LOG_CAP);
    for (const t of proxyTaps) t(e);
  };
  const proxy = createProxyHandler({ oauth, logger: app.logger, onTap: recordProxyTap });
  // serve-console live view (TTY-gated, see liveview.ts): every request and
  // event as one line on stdout, right where `npm run serve` runs
  startLiveView({ events: manager, httpTaps });

  /**
   * Serves the dashboard: the built webui/dist when present (dev), else the
   * copy embedded in the compiled binary. Client-side routes fall back to
   * index.html; traversal is refused (embedded assets are map lookups, so
   * only real keys resolve). Returns false when the path is not servable.
   */
  const serveWebui = async (res: http.ServerResponse, pathname: string): Promise<boolean> => {
    if (webuiBuilt()) {
      let file = path.resolve(webuiDir, "." + seg(pathname));
      if (file !== path.resolve(webuiDir) && !file.startsWith(path.resolve(webuiDir) + path.sep)) {
        return false; // traversal — not ours to serve
      }
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) throw new Error("not a file");
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] ?? "application/octet-stream",
          "Content-Length": stat.size,
          "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
        });
        fs.createReadStream(file).pipe(res);
        return true;
      } catch {
        // SPA fallback: a deep link like /tasks/xyz has no file — the app routes it
        const index = path.join(webuiDir, "index.html");
        const stat = fs.statSync(index); // exists per webuiBuilt()
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": stat.size,
          "Cache-Control": "no-cache",
        });
        fs.createReadStream(index).pipe(res);
        return true;
      }
    }
    // compiled binary: serve the embedded copy (keyed lookups — only real
    // asset paths resolve, so traversal cannot escape the map)
    const embedded = await embeddedWebui();
    if (embedded["index.html"]) {
      const key = seg(pathname).replace(/^\/+/, "");
      const rel = embedded[key] !== undefined ? key : "index.html"; // SPA fallback
      const ext = path.extname(rel).toLowerCase();
      const body = embedded[rel]!;
      res.writeHead(200, {
        "Content-Type": MIME[ext] ?? "application/octet-stream",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      });
      res.end(body);
      return true;
    }
    if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(NOT_BUILT_PAGE);
      return true;
    }
    return false;
  };

  /**
   * `Authorization: Bearer <key>`, `x-api-key` (what Anthropic SDK clients
   * send when the server key is set as their API key) or `?key=` — browsers
   * cannot set headers on EventSource/img tags, so the query form keeps the
   * dashboard (and only it; the key is a localhost server key) workable.
   * Never logged: http.request logs the path without the query string.
   */
  /**
   * Which client (named key) is calling, or undefined for a bad key. The
   * "default" client is the admin view: it sees every other client's tasks.
   */
  const authClient = (req: http.IncomingMessage, url: URL): string | undefined => {
    const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
    const h = req.headers["x-api-key"];
    const candidate = m?.[1] ?? (typeof h === "string" ? h : undefined) ?? url.searchParams.get("key") ?? "";
    if (!candidate) return undefined;
    const got = Buffer.from(candidate);
    for (const kb of keyBuffers) {
      if (got.length === kb.length && crypto.timingSafeEqual(got, kb)) return clientKeys.get(candidate.toString());
    }
    return undefined;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(data),
      ...headers,
    });
    res.end(data);
  };

  const readBody = (req: http.IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      let overflowed = false;
      req.on("data", (c: Buffer) => {
        if (overflowed) return; // drain the rest so the 413 response reaches the client
        size += c.length;
        if (size > MAX_BODY) {
          overflowed = true;
          chunks.length = 0;
          reject(new HttpError(413, "body_too_large", `request body exceeds ${MAX_BODY} bytes`));
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (!overflowed) resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });

  /** Parses a JSON object body ({} when empty). */
  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const text = await readBody(req);
    if (!text.trim()) return {};
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch (e) {
      throw new HttpError(400, "invalid_json", `invalid JSON body: ${(e as Error).message}`);
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "invalid_json", "the body must be a JSON object");
    return v as Record<string, unknown>;
  };

  const intParam = (url: URL, name: string, dflt: number, min: number, max: number): number => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, "invalid_request", `\`${name}\` must be an integer ${min}-${max}`);
    return n;
  };
  const flag = (url: URL, name: string): boolean => /^(1|true|yes)$/i.test(url.searchParams.get(name) ?? "");

  /**
   * Decodes one client-supplied URL path segment. A malformed escape is a
   * client error, never an unhandled URIError — `decodeURIComponent` throws on
   * a bare "%" and that used to escape dispatch's catch-all as a 500 on four
   * routes, one of them (the public dashboard route) reachable unauthenticated.
   */
  const seg = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      throw new HttpError(400, "invalid_request", "malformed percent-encoding in the request path");
    }
  };

  /**
   * A workdir the dashboard's "run a test task" button can submit against:
   * the configured default when there is one, otherwise a directory under the
   * OS temp dir (created here so submit validation passes). Null when neither
   * is usable (e.g. restricted allowed_roots) — the dashboard then shows the
   * submit error instead of guessing a path.
   */
  const workdirSuggestion = (): string | null => {
    if (app.defaultWorkdir) return app.defaultWorkdir;
    const dir = path.join(os.tmpdir(), "wrongforge-demo");
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------------ SSE

  const sseStart = (res: http.ServerResponse): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
  };

  /** Streams one task's events: replay from `after`, then live, then `end`. */
  const streamTask = (res: http.ServerResponse, taskId: string, after: number, cancelOnDisconnect = false): void => {
    sseStart(res);
    let last = after;
    let replaying = true;
    let ended = false;
    const buffer: TaskEvent[] = [];

    const cleanup = (): void => {
      unsub();
      clearInterval(ping);
    };
    const finish = (): void => {
      if (ended) return;
      ended = true;
      cleanup();
      if (!res.writableEnded) {
        res.write(`event: end\ndata: ${JSON.stringify({ task_id: taskId, status: manager.get(taskId)?.status })}\n\n`);
        res.end();
      }
    };
    const send = (ev: TaskEvent): void => {
      if (ended || ev.seq <= last) return;
      last = ev.seq;
      if (!res.writableEnded) res.write(`id: ${ev.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (TERMINAL_EVENTS.has(ev.type)) finish();
    };
    // subscribe BEFORE replaying so nothing falls into the gap; dedupe by seq
    const unsub = manager.subscribe((ev) => {
      if (ev.task_id !== taskId) return;
      if (replaying) buffer.push(ev);
      else send(ev);
    });
    const ping = setInterval(() => !res.writableEnded && res.write(": ping\n\n"), 15_000);
    res.on("close", () => {
      if (ended) return;
      ended = true;
      cleanup();
      if (cancelOnDisconnect) void manager.cancel(taskId, "client disconnected");
    });

    for (let batch = manager.events(taskId, last, 1000); batch.length && !ended; batch = manager.events(taskId, last, 1000)) {
      for (const ev of batch) send(ev);
    }
    if (ended) return;
    replaying = false;
    for (const ev of buffer.sort((a, b) => a.seq - b.seq)) send(ev);
    if (ended) return;
    const t = manager.get(taskId);
    if (!t || isTerminal(t.status)) finish();
  };

  /** Long-poll: resolves with new events, or [] after `waitMs`. */
  const waitForEvents = (taskId: string, after: number, limit: number, waitMs: number, signal: AbortSignal): Promise<TaskEvent[]> =>
    new Promise((resolve) => {
      let done = false;
      const settle = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsub();
        resolve(manager.events(taskId, after, limit));
      };
      const unsub = manager.subscribe((ev) => ev.task_id === taskId && settle());
      const timer = setTimeout(settle, waitMs);
      signal.addEventListener("abort", settle, { once: true });
      // an event may have been written between the caller's check and the subscription
      if (manager.events(taskId, after, 1).length) settle();
    });

  // ------------------------------------------------------------- handlers

  const taskNotFound = (id: string): HttpError => new HttpError(404, "task_not_found", `no task "${id}"`);

  async function submitTask(req: http.IncomingMessage, res: http.ServerResponse, client: string): Promise<void> {
    const body = await readJson(req);
    const { wait, stream, cancel_on_disconnect, ...rest } = body as Record<string, unknown> & {
      wait?: boolean;
      stream?: boolean;
      cancel_on_disconnect?: boolean;
    };
    if (!oauth.signedIn) throw new HttpError(503, "not_signed_in", "WrongForge is not signed in (run `npm run import` or `npm run login`)");
    // the client comes from the API key, never from the body
    const { task, deduplicated } = manager.submit(rest as unknown as SubmitRequest, client);
    const location = { Location: `/v1/tasks/${task.id}` };

    if (stream === true) {
      streamTask(res, task.id, 0, cancel_on_disconnect === true);
      return;
    }
    if (wait === true) {
      res.on("close", () => {
        if (cancel_on_disconnect === true && !res.writableEnded) void manager.cancel(task.id, "client disconnected");
      });
      const final = await manager.waitFor(task.id);
      if (!res.destroyed && !res.writableEnded) json(res, 200, { task: final, deduplicated }, location);
      return;
    }
    json(res, deduplicated ? 200 : 202, { task, deduplicated }, location);
  }

  async function taskEvents(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): Promise<void> {
    const task = manager.get(id);
    if (!task) throw taskNotFound(id);
    const lastEventId = Number(req.headers["last-event-id"]);
    const afterParam = url.searchParams.get("after");
    const after = afterParam !== null ? intParam(url, "after", 0, 0, Number.MAX_SAFE_INTEGER) : Number.isInteger(lastEventId) && lastEventId > 0 ? lastEventId : 0;

    if ((req.headers.accept ?? "").includes("text/event-stream") || flag(url, "stream")) {
      streamTask(res, id, after);
      return;
    }
    const limit = intParam(url, "limit", 1000, 1, 5000);
    const waitMs = intParam(url, "wait_ms", 0, 0, 30_000);
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    let events = manager.events(id, after, limit);
    if (!events.length && waitMs > 0 && !isTerminal(task.status)) events = await waitForEvents(id, after, limit, waitMs, ac.signal);
    const cur = manager.get(id)!;
    json(res, 200, {
      task_id: id,
      status: cur.status,
      terminal: isTerminal(cur.status),
      events,
      next_after: events.length ? events[events.length - 1]!.seq : after,
    });
  }

  function globalEvents(req: http.IncomingMessage, res: http.ServerResponse, url: URL, client: string): void {
    const taskFilter = url.searchParams.get("task_id");
    const sessionFilter = url.searchParams.get("session_id");
    // Named clients only ever see their own tasks: every event is attributed
    // through its task record, and the unfiltered traffic taps (which carry
    // no task_id and cannot be attributed) are dropped for them wholesale —
    // the same rule filtered feeds already follow (F201).
    const scoped = client !== "default";
    const ownsTask = (taskId: string | undefined): boolean =>
      taskId !== undefined && app.taskStore.get(taskId)?.client === client;
    // One predicate for the WHOLE feed — the replayed backlog and the live tail.
    // It used to guard only the live subscription, so a filtered subscriber was
    // handed every other session's replayed backlog on connect (F201).
    // http.request frames carry no task_id/session_id, so they cannot be
    // attributed to a filtered feed and are dropped wholesale when a filter is
    // active — that is what "the filter filters the feed" means. Unfiltered
    // dashboards (the dashboard itself uses /v1/events with no filter) keep the
    // traffic view.
    const filtered = scoped || taskFilter !== null || sessionFilter !== null;
    const keep = (ev: { task_id?: string; session_id?: string }): boolean => {
      if (scoped && !ownsTask(ev.task_id)) return false;
      if (taskFilter && ev.task_id !== taskFilter) return false;
      if (sessionFilter && ev.session_id !== sessionFilter) return false;
      return true;
    };
    sseStart(res);
    // Backlog first: the recent-traffic ring AND the newest task events from
    // disk (the agent's rounds, tool calls, texts — heartbeats skipped), so a
    // dashboard opened late — or after a serve restart — immediately sees
    // what ran while it was away. Everything below is synchronous — no live
    // frame can fall into the gap before the subscriptions attach.
    for (const e of httpTapLog) if (!filtered) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    // proxy.call frames carry no task_id/session_id either — same unfiltered-
    // only rule as http.request above.
    for (const e of proxyTapLog) if (!filtered) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    for (const ev of manager.recentEvents()) if (keep(ev)) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    const unsub = manager.subscribe((ev) => {
      if (!keep(ev)) return;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    });
    // live HTTP traffic: every /v1 call except this stream itself (watching
    // the watcher would drown the feed). Not persisted — pure live view.
    // The tap is on `finish`: a held-open request (wait/stream submit) only
    // appears once it completes.
    const tap = (e: HttpTapEvent): void => {
      if (res.writableEnded || filtered) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    httpTaps.add(tap);
    // live proxy-call traffic for the dashboard's "Proxy" tab — same shape
    // of fan-out, separate channel (see proxyTaps/proxyTapLog above).
    const proxyTap = (e: ProxyCallEvent): void => {
      if (res.writableEnded || filtered) return;
      res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    };
    proxyTaps.add(proxyTap);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    res.on("close", () => {
      unsub();
      httpTaps.delete(tap);
      proxyTaps.delete(proxyTap);
      clearInterval(ping);
    });
  }

  function info(): unknown {
    const ctx = manager.contextConfig;
    const c = manager.counts();
    const mcp = app.mcp.status();
    return {
      name: APP_NAME,
      version: VERSION,
      protocol: 1,
      /** Optional submit features this server understands (older servers ignore unknown fields). */
      features: ["builtin_tools", "effort"],
      signed_in: oauth.signedIn,
      default_model: app.defaultModel,
      models: Object.keys(KNOWN_MODELS),
      /** Per-model facts an orchestrator needs before submitting: which
       * effort levels each model accepts (empty = no effort support — mirrors
       * the capability shape Claude Code's own catalog serves). */
      model_details: Object.entries(KNOWN_MODELS).map(([id, description]) => ({
        id,
        description,
        effort_levels: [...effortSupport(id)],
      })),
      queue: { ...c, max_concurrency: manager.maxConcurrency },
      workdir: {
        default: app.defaultWorkdir ?? null,
        required: !app.defaultWorkdir,
        allowed_roots: app.allowedRoots,
        lock_by_default: app.defaultWorkdirLock,
        suggestion: workdirSuggestion(),
      },
      context: { window: ctx.window, compact_at: ctx.compactAt, clear_at: ctx.clearAt, keep_turns: ctx.keepTurns },
      cache: { default: process.env.WRONGFORGE_CACHE || "1h", modes: ["5m", "1h", "off"] },
      effort: { default: process.env.WRONGFORGE_EFFORT || "high", levels: ["low", "medium", "high", "xhigh", "max", "off"] },
      /** A newer GitHub release was seen at startup / by the periodic check. */
      update: lastUpdateCheck(),
      /** WRONGFORGE_AUTO_UPDATE=1: install it automatically once idle. `enabled`
       * reflects whether that is actually armed (false in source mode even with
       * the flag set — see the startup warning); `supervised` means a
       * WRONGFORGE_SUPERVISE=1 parent owns restarting this process afterward. */
      auto_update: { enabled: process.env.WRONGFORGE_AUTO_UPDATE === "1" && isCompiledBinary(), supervised: !!process.env.WRONGFORGE_SUPERVISED_CHILD },
      limits: { max_body_bytes: MAX_BODY, max_steps: 500, default_max_steps: 50 },
      proxy: {
        enabled: proxyEnabled(),
        /** Anthropic-compatible endpoints any SDK / Claude Code can target
         * via ANTHROPIC_BASE_URL (client key = this server's API key). */
        endpoints: ["POST /v1/messages", "POST /v1/messages/count_tokens", "GET /v1/models", "GET /v1/models/:id"],
        max_body_bytes: proxyMaxBody(),
      },
      webhook: { signature: "HMAC-SHA256 over '<timestamp>.<body>', header X-WrongForge-Signature: sha256=<hex>", key: process.env.WRONGFORGE_WEBHOOK_SECRET ? "WRONGFORGE_WEBHOOK_SECRET" : "the API key" },
      tools: Object.keys(agentTools),
      tool_guides: loadPromptFiles(opts.promptDir).map((f) => f.name),
      mcp: { config_file: mcp.file, servers: mcp.servers.length },
      dirs: app.dirs,
    };
  }

  async function sessionRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, parts: string[], client: string): Promise<boolean> {
    const method = req.method ?? "GET";
    const sessions = app.sessions;
    // named clients see only their own sessions (legacy sessions, which have
    // no owner on disk, belong to the default key)
    const scopedList = (): unknown[] => (client === "default" ? sessions.list() : sessions.list().filter((s) => (s.owner ?? "default") === client));

    if (parts.length === 2) {
      if (method === "GET") return json(res, 200, { sessions: scopedList() }), true;
      if (method === "POST") {
        const body = await readJson(req);
        const id = body.id === undefined ? `ses_${crypto.randomBytes(8).toString("hex")}` : body.id;
        if (!SessionStore.isValidId(id)) throw new HttpError(400, "invalid_request", "`id` must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
        if (sessions.exists(id)) throw new HttpError(409, "session_exists", `session "${id}" already exists`);
        return json(res, 201, { session: sessions.create(id, new Date(), client) }, { Location: `/v1/sessions/${id}` }), true;
      }
      return false;
    }

    const id = seg(parts[2]!);
    if (!SessionStore.isValidId(id)) throw new HttpError(400, "invalid_request", "invalid session id");
    const notFound = new HttpError(404, "session_not_found", `no session "${id}"`);
    const forbidden = new HttpError(403, "session_not_owned", `session "${id}" belongs to another client`);
    const assertVisible = (): void => {
      const meta = sessions.meta(id);
      if (!meta) throw notFound;
      if (client !== "default" && (meta.owner ?? "default") !== client) throw forbidden;
    };

    if (parts.length === 3) {
      if (method === "GET") {
        assertVisible();
        const meta = sessions.meta(id)!;
        return json(res, 200, { session: meta, in_use: manager.sessionInUse(id) }), true;
      }
      if (method === "DELETE") {
        assertVisible();
        if (manager.sessionInUse(id)) throw new HttpError(409, "session_busy", "a task of this session is queued or running");
        sessions.delete(id);
        return json(res, 200, { deleted: id }), true;
      }
      return false;
    }

    if (parts.length === 4 && parts[3] === "messages" && method === "GET") {
      assertVisible();
      const page = sessions.page(id, intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER), intParam(url, "limit", 100, 1, 1000));
      if (!page) throw notFound;
      return json(res, 200, { session_id: id, ...page }), true;
    }

    if (parts.length === 4 && parts[3] === "compact" && method === "POST") {
      assertVisible();
      const body = await readJson(req);
      try {
        return json(res, 200, await manager.compactSession(id, typeof body.model === "string" ? body.model : undefined)), true;
      } catch (e) {
        if (e instanceof SubmitError) throw new HttpError(e.status, e.code, e.message);
        throw new HttpError(502, "compaction_failed", (e as Error).message);
      }
    }
    return false;
  }

  async function mcpRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL, parts: string[]): Promise<boolean> {
    const method = req.method ?? "GET";
    const mcp = app.mcp;

    if (parts.length === 3 && parts[2] === "servers" && method === "GET") return json(res, 200, mcp.status()), true;
    if (parts.length === 3 && parts[2] === "import" && method === "POST") {
      const body = await readJson(req);
      const { overwrite, ...doc } = body;
      return json(res, 200, mcp.importServers(doc, { overwrite: overwrite === true })), true;
    }
    if (parts[2] !== "servers" || parts.length < 4) return false;

    const name = seg(parts[3]!);
    const sub = parts[4];
    const known = (): void => {
      if (!mcp.store.get(name)) throw new HttpError(404, "mcp_server_not_found", `no MCP server named "${name}"`);
    };

    if (parts.length === 4 && method === "PUT") {
      const spec = await readJson(req);
      const saved = mcp.addServer(name, spec);
      const body: Record<string, unknown> = { name, existed: saved.existed, server: mcp.status().servers.find((s) => s.name === name) };
      if (flag(url, "test")) body.test = await mcp.test(name);
      return json(res, saved.existed ? 200 : 201, body), true;
    }
    if (parts.length === 4 && method === "DELETE") {
      if (!mcp.removeServer(name)) throw new HttpError(404, "mcp_server_not_found", `no MCP server named "${name}"`);
      return json(res, 200, { removed: name }), true;
    }
    if (parts.length === 5 && sub === "test" && method === "POST") {
      known();
      return json(res, 200, await mcp.test(name)), true;
    }
    if (parts.length === 5 && sub === "tools" && method === "GET") {
      known();
      const defs = await mcp.listTools(name, { refresh: flag(url, "refresh") });
      const one = url.searchParams.get("tool");
      if (one) {
        const d = defs.find((x) => x.name === one);
        if (!d) throw new HttpError(404, "mcp_tool_not_found", `server "${name}" has no tool "${one}"`);
        return json(res, 200, { server: name, tool: d }), true;
      }
      return json(res, 200, { server: name, tools: defs }), true;
    }
    if (parts.length === 5 && (sub === "enable" || sub === "disable") && method === "POST") {
      known();
      mcp.setEnabled(name, sub === "enable");
      return json(res, 200, { server: mcp.status().servers.find((s) => s.name === name) }), true;
    }
    return false;
  }

  // -------------------------------------------------------------- dispatch

  async function dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const parts = url.pathname.split("/").filter(Boolean); // ["v1","tasks",id,…]

    if (method === "GET" && url.pathname === "/health") {
      const c = manager.counts();
      return json(res, 200, { ok: true, name: APP_NAME, version: VERSION, signed_in: oauth.signedIn, ...c });
    }
    // The dashboard shell is public (its data still requires the key below);
    // everything under /v1 stays API-only.
    if (method === "GET" && parts[0] !== "v1") {
      if (await serveWebui(res, url.pathname)) return;
      if (url.pathname === "/") {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("WrongForge API — see /v1/info. Dashboard: npm run webui:build\n");
        return;
      }
    }
    const client = authClient(req, url);
    if (client === undefined) {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw new HttpError(401, "unauthorized", "missing or wrong API key (send `Authorization: Bearer <key>`)");
    }
    if (parts[0] !== "v1") throw new HttpError(404, "not_found", "unknown route");
    const area = parts[1];

    // Plan-usage state (5h session window, weekly limit, extra usage) from the
    // same endpoint Claude Code's /usage reads; cached 5 minutes server-side.
    if (area === "usage" && parts.length === 2 && method === "GET") {
      const u = await fetchPlanUsage(oauth, { force: url.searchParams.get("force") === "1" });
      if (!u) throw new HttpError(502, "usage_unavailable", "could not read plan usage (signed in? network?)");
      return json(res, 200, {
        five_hour: u.fiveHour,
        weekly: u.weekly,
        extra_usage: u.extraUsage,
      });
    }

    if (area === "tasks") {
      if (parts.length === 2) {
        if (method === "POST") return submitTask(req, res, client);
        if (method === "GET") {
          const raw = url.searchParams.get("status");
          const statuses = raw ? (raw.split(",").map((s) => s.trim()) as TaskStatus[]) : undefined;
          if (statuses?.some((s) => !ALL_STATUSES.includes(s))) throw new HttpError(400, "invalid_request", `\`status\` must be a comma list of ${ALL_STATUSES.join(", ")}`);
          const limit = intParam(url, "limit", 50, 1, 500);
          // named clients see only their own tasks; the default key sees all
          const tasks = manager.listFor(client, {
            status: statuses,
            session_id: url.searchParams.get("session_id") ?? undefined,
            before: url.searchParams.get("before") ?? undefined,
            limit,
          });
          return json(res, 200, { tasks, next_before: tasks.length === limit ? tasks[tasks.length - 1]!.created_at : null });
        }
      } else {
        const id = seg(parts[2]!);
        // a foreign task does not exist as far as this client is concerned
        // (404, not 403 — no existence leak across orchestrators)
        if (!manager.visibleTo(id, client)) throw taskNotFound(id);
        if (parts.length === 3 && method === "GET") {
          const task = manager.get(id);
          if (!task) throw taskNotFound(id);
          // A queued task's wait is only useful if it is observable: the live
          // position and block reason ride along while status is "queued"
          // (issue #7 — a task can sit in the queue for minutes in silence).
          const qi = task.status === "queued" ? manager.queueInfoOf(id) : undefined;
          return json(res, 200, qi ? { task, queue_position: qi.position, waiting_for: qi.waiting_for } : { task });
        }
        if (parts.length === 4 && parts[3] === "events" && method === "GET") return taskEvents(req, res, id, url);
        if (parts.length === 4 && parts[3] === "cancel" && method === "POST") {
          const body = await readJson(req);
          const r = await manager.cancel(id, typeof body.reason === "string" ? body.reason : undefined);
          if (!r) throw taskNotFound(id);
          return json(res, 200, r);
        }
      }
    } else if (area === "events" && parts.length === 2 && method === "GET") {
      return globalEvents(req, res, url, client);
    } else if (area === "messages" || area === "models") {
      // Anthropic-compatible proxy surface (src/proxy.ts) — same key auth as
      // everything else; returns false for shapes it does not serve
      if (proxyEnabled() && (await proxy(req, res, method, url.pathname, url.search))) return;
    } else if (area === "sessions") {
      if (await sessionRoutes(req, res, url, parts, client)) return;
    } else if (area === "mcp") {
      if (await mcpRoutes(req, res, url, parts)) return;
    } else if (area === "info" && parts.length === 2 && method === "GET") {
      return json(res, 200, info());
    } else if (area === "tools" && parts.length === 2 && method === "GET") {
      return json(res, 200, { tools: Object.entries(agentTools).map(([name, t]) => ({ name, description: t.description })) });
    } else if (area === "maintenance" && parts[2] === "run" && parts.length === 3 && method === "POST") {
      return json(
        res,
        200,
        await runMaintenance({
          logger: app.logger, taskStore: app.taskStore, sessions: app.sessions, retention: app.retention,
          busySessions: () => manager.busySessions(),
        }),
      );
    }
    throw new HttpError(404, "not_found", `no route for ${method} ${url.pathname}`);
  }

  return http.createServer((req, res) => {
    const started = Date.now();
    res.on("finish", () => {
      const path = (req.url ?? "").split("?")[0];
      // polling is frequent: only mutations are logged at info level
      app.logger.log(req.method === "GET" ? "debug" : "info", "http.request", {
        method: req.method, path, status: res.statusCode, duration_ms: Date.now() - started, ip: req.socket.remoteAddress,
      });
      // dashboard live view: everything under /v1 except the SSE stream
      // itself (watching the watcher would drown the feed in its own pings);
      // recorded so late-joining dashboards get the backlog replayed
      if (path.startsWith("/v1") && path !== "/v1/events") {
        recordTap({
          type: "http.request",
          ts: new Date().toISOString(),
          method: req.method ?? "?",
          path,
          status: res.statusCode,
          duration_ms: Date.now() - started,
        });
      }
    });
    dispatch(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (e instanceof HttpError) return json(res, e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof SubmitError) return json(res, e.status, { error: { code: e.code, message: e.message } });
      if (e instanceof McpConfigError) return json(res, 400, { error: { code: "invalid_mcp_config", message: e.message } });
      if (e instanceof McpError) {
        const status = e.code === "unknown_server" ? 404 : e.code === "server_disabled" ? 409 : 502;
        return json(res, status, { error: { code: e.code, message: e.message } });
      }
      app.logger.error("http.unhandled", { method: req.method, path: (req.url ?? "").split("?")[0], error: e });
      json(res, 500, { error: { code: "internal_error", message: (e as Error).message } });
    });
  });
}

// ------------------------------------------------------------------ CLI entry
export interface EnvServer {
  app: App;
  server: http.Server;
  port: number;
  shutdown: (signal?: string) => Promise<void>;
}

/**
 * The `npm run serve` startup as a callable: resolve the key, build the app,
 * listen, print the banner, wire graceful shutdown. Exported so the test
 * suite can run the real entry in-process (and shut it down cleanly).
 */
export async function startEnvServer(): Promise<EnvServer> {
  cleanupOldBinary(); // remove a binary renamed aside by the previous update
  const resolved = resolveApiKey(); // env -> saved file -> generate + save
  const clients = resolveClientKeys(resolved.key, process.env, clientKeysFile()); // + named client keys (fail closed on bad config)
  const oauth = new ClaudeOAuth(process.env.CLAUDE_TOKEN_STORE || undefined);
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 8787);
  const app = createApp({ oauth, apiKey: resolved.key });
  const recovered = app.manager.recover(); // tasks left over from a previous run
  const stopMaintenance = startMaintenance({
    logger: app.logger, taskStore: app.taskStore, sessions: app.sessions, retention: app.retention,
    busySessions: () => app.manager.busySessions(),
  });
  const server = createAgentServer({ apiKey: resolved.key, clientKeys: clients.byKey, oauth, app });

  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `Port ${port} is already in use — another WrongForge running? Set PORT to use a different one.`
        : `Server error: ${e.message}`,
    );
    process.exit(1);
  });
  await new Promise<void>((resolveListen) => {
    server.listen(port, host, () => {
      app.logger.info("server.started", { host, port, version: VERSION, model: app.defaultModel, max_concurrency: app.manager.maxConcurrency, recovered: recovered.length });
      printBanner({
        version: VERSION,
        host,
        port,
        key: resolved,
        signedIn: oauth.signedIn,
        model: app.defaultModel || DEFAULT_MODEL,
        dataDir: dataDir(),
        logDir: app.dirs.logs,
        maxConcurrency: app.manager.maxConcurrency,
        promptFiles: loadPromptFiles().map((f) => f.name),
        defaultWorkdir: app.defaultWorkdir ?? null,
        mcpServers: app.mcp.status().servers.length,
        recoveredTasks: recovered.length,
        proxyUrl: proxyEnabled() ? `http://${host}:${port}` : null,
      });
      if (fs.existsSync(path.join(DEFAULT_WEBUI_DIR, "index.html"))) {
        console.log(`  dashboard:   http://${host}:${port}/`);
      }
      // release check (off with WRONGFORGE_UPDATE_CHECK=0): one at startup,
      // then daily — the banner, the log and /v1/info all surface the result
      const announceUpdate = (): void => {
        void checkForUpdate().then((u) => {
          if (!u) return;
          console.log(`  update:      v${u.latest} available (running v${u.current}) — ${u.url}`);
          console.log(`               run \`wrongforge update\` to install it`);
          app.logger.info("update.available", { current: u.current, latest: u.latest, repo: UPDATE_REPO });
        });
      };
      announceUpdate();
      setInterval(announceUpdate, 24 * 3600 * 1000).unref();
      resolveListen();
    });
  });

  // OAuth keep-alive: an idle server never calls getAccessToken, so the token
  // chain would go stale between tasks and the refresh token would eventually
  // die of disuse — the "run Claude Code once in a while" ritual this removes.
  // Checks every WRONGFORGE_TOKEN_KEEPALIVE_MS (default 5 min; 0 disables) and
  // refreshes once the access token has <15 min left, roughly the cadence of
  // an actively used client. A dead session backs off exponentially (capped
  // at 1 h) instead of hammering the token endpoint every interval.
  const keepAliveMs = Number(process.env.WRONGFORGE_TOKEN_KEEPALIVE_MS ?? 5 * 60_000);
  let keepAliveBackoffUntil = 0;
  let keepAliveFailures = 0;
  const keepAlive = (): void => {
    if (!Number.isFinite(keepAliveMs) || keepAliveMs <= 0 || !oauth.signedIn) return;
    if (Date.now() < keepAliveBackoffUntil) return;
    void oauth.getAccessToken(15 * 60_000).then(
      () => {
        keepAliveFailures = 0;
      },
      (e) => {
        keepAliveFailures++;
        const waitMs = Math.min(keepAliveMs * 2 ** keepAliveFailures, 60 * 60_000);
        keepAliveBackoffUntil = Date.now() + waitMs;
        app.logger.warn("auth.keepalive_failed", { error: (e as Error).message, retry_in_ms: waitMs });
      },
    );
  };
  keepAlive();
  const keepAliveTimer = setInterval(keepAlive, keepAliveMs);
  keepAliveTimer.unref();

  // Automatic self-update (opt-in, WRONGFORGE_AUTO_UPDATE=1): installs a
  // release the daily checkForUpdate() above already found — this timer does
  // not itself ask GitHub again, it only watches for the moment both the
  // known result and the idle condition line up, at a much tighter interval
  // than the daily check. Only ever installs while idle (no queued/running
  // task), per the design: an update must never interrupt work in progress.
  // Source mode (not the compiled binary) cannot self-update at all — warn
  // once at startup instead of on every poll, and never arm the timer.
  const autoUpdateEnabled = process.env.WRONGFORGE_AUTO_UPDATE === "1";
  if (autoUpdateEnabled && !isCompiledBinary()) {
    app.logger.warn("auto_update.unavailable", { reason: "not running as the compiled binary — run the release executable to enable WRONGFORGE_AUTO_UPDATE" });
  }
  const autoUpdatePollMs = Number(process.env.WRONGFORGE_AUTO_UPDATE_POLL_MS ?? 2 * 60_000);
  let autoUpdateTimer: NodeJS.Timeout | undefined;

  let stopping = false;
  // Tears down the listening port and background work, in order, so nothing
  // that wants to reuse this port (an update's respawn, or a supervisor that
  // will restart this process) can race this process for it. Idempotent —
  // a second caller while shutdown is already underway gets the same promise.
  let stopPromise: Promise<void> | null = null;
  const stopServing = (signal: string): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    console.log(`\n${signal}: stopping — interrupting running tasks…`);
    app.logger.info("server.stopping", { signal });
    stopMaintenance();
    clearInterval(keepAliveTimer);
    clearInterval(autoUpdateTimer);
    stopPromise = (async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.manager.shutdown();
      await app.mcp.closeAll();
      app.logger.info("server.stopped", {});
    })();
    return stopPromise;
  };

  if (autoUpdateEnabled && isCompiledBinary() && Number.isFinite(autoUpdatePollMs) && autoUpdatePollMs > 0) {
    // F963: prepareUpdate() is a real network download that can easily
    // outlast one poll interval on a slow connection — without this guard
    // (the same shape as maintenance.ts's own tick, F703) every tick calls
    // it again regardless, so a slow connection accumulates more and more
    // concurrent downloads of the same release instead of one at a time.
    let preparing = false;
    const maybeAutoUpdate = (): void => {
      if (stopping || preparing) return;
      const u = lastUpdateCheck();
      if (!u) return; // nothing newer known yet — the daily check will find it
      const c = app.manager.counts();
      if (c.queued > 0 || c.running > 0) return; // busy — try again next poll
      preparing = true;
      app.logger.info("auto_update.preparing", { current: u.current, latest: u.latest });
      void prepareUpdate()
        .then(
          (prepared) => {
            // Re-checked busy-ness is pointless here (the download itself can
            // take a while and a task could have started), but the install
            // phase below is what actually stops the server, so check once
            // more right before committing to it.
            if (!prepared || stopping) return;
            const c2 = app.manager.counts();
            if (c2.queued > 0 || c2.running > 0) return;
            app.logger.info("auto_update.installing", { current: prepared.rel.current, latest: prepared.rel.latest });
            void stopServing("auto-update").then(() => installUpdate(prepared, { respawn: !process.env.WRONGFORGE_SUPERVISED_CHILD }));
          },
          (e) => app.logger.warn("auto_update.prepare_failed", { error: (e as Error).message }), // network hiccup — nothing was torn down, try again next poll
        )
        .finally(() => {
          preparing = false;
        });
    };
    autoUpdateTimer = setInterval(maybeAutoUpdate, autoUpdatePollMs);
    autoUpdateTimer.unref();
  }

  const shutdown = (signal = "shutdown"): void => {
    void stopServing(signal).then(() => process.exit(0));
    setTimeout(() => process.exit(0), 20_000).unref(); // never hang on exit
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  return { app, server, port: (server.address() as { port: number }).port, shutdown: () => Promise.resolve(shutdown()) };
}

const isMain = process.argv[1] && /server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  try {
    await startEnvServer();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
