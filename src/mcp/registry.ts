/**
 * MCP client registry: connects to the configured MCP servers, discovers
 * their tools and calls them.
 *
 *  - Connections are POOLED: opened on first use, reused by later tasks and
 *    closed after `idleMs` without use (stdio servers started with `npx` are
 *    slow to boot, so they must not restart for every task).
 *  - Tool lists are cached for `toolsTtlMs`.
 *  - Two ways to use a server's tools:
 *      eager  `loadForTask` turns them into typed tools `mcp_<server>_<tool>`
 *             (full JSON schemas, best accuracy, costs prompt tokens);
 *      lazy   `listTools` / `callTool` behind the `mcp_tools` / `mcp_call`
 *             agent tools (no schemas in the prompt; works for servers added
 *             in the middle of a task).
 *  - Calls never throw into the agent loop: failures come back as
 *    `{ ok:false, error }`, like with built-in tools.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { dynamicTool, type ToolSet } from "../tool.js";
import * as crypto from "node:crypto";
import type { Logger } from "../log.js";
import { toolsHash, type LoadedDef } from "../tools/gateway.js";
import { truncateMiddle } from "../tools/util.js";
import {
  McpConfigError,
  McpStore,
  expandEnv,
  isValidServerName,
  redactSpec,
  type ImportResult,
  type McpServerSpec,
  type NormalizedSpec,
} from "./config.js";

export class McpError extends Error {
  constructor(
    readonly code: "mcp_unavailable" | "unknown_server" | "server_disabled" | "mcp_error",
    message: string,
  ) {
    super(message);
  }
}

/** A tool as the MCP server describes it. */
export interface McpToolDef {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface McpLoadedDef extends LoadedDef {
  server: string;
}

export interface McpServerLoad {
  name: string;
  ok: boolean;
  tools: number;
  error?: string;
}

export interface McpLoadResult {
  tools: ToolSet;
  defs: McpLoadedDef[];
  servers: McpServerLoad[];
  hash: string;
  warnings: string[];
}

export interface McpServerStatus {
  name: string;
  spec: McpServerSpec;
  connected: boolean;
  tools_cached?: number;
  last_error?: string;
  server_info?: { name?: string; version?: string };
}

export interface McpTestResult {
  ok: boolean;
  error?: string;
  server_info?: { name?: string; version?: string };
  instructions?: string;
  tools: { name: string; description: string }[];
  duration_ms: number;
}

interface Conn {
  name: string;
  key: string;
  spec: NormalizedSpec;
  client: Client;
  refs: number;
  idle?: NodeJS.Timeout;
  tools?: { at: number; defs: McpToolDef[] };
}

export interface RegistryOptions {
  store: McpStore;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  /** Close a pooled connection after this long without use (default 5 min). */
  idleMs?: number;
  /** Reuse a tool list for this long (default 60 s; 0 = always ask the server). */
  toolsTtlMs?: number;
  /** Names that exposed tools must not shadow (built-in tools). */
  reservedNames?: ReadonlySet<string>;
  /** Cap on individually exposed tools per task (default 128). */
  maxEagerTools?: number;
}

const MAX_OUTPUT_CHARS = 60_000;
const matches = (patterns: string[], name: string): boolean =>
  patterns.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : p === name));

/** `mcp_<server>_<tool>`, valid for the Anthropic API (^[A-Za-z0-9_-]{1,64}$). */
export function exposedName(server: string, tool: string): string {
  const base = `mcp_${server}_${tool}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (base.length <= 64) return base;
  const h = crypto.createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 6);
  return `${base.slice(0, 57)}_${h}`;
}

export class McpRegistry {
  private pool = new Map<string, Conn>();
  private connecting = new Map<string, Promise<Conn>>();
  private lastError = new Map<string, string>();
  /**
   * Bumped by `invalidate`/`closeAll`. A connect captures it before it suspends and
   * compares after: a connection established across a shutdown or a config change
   * must never be published into the pool.
   */
  private gen = 0;
  private readonly env: NodeJS.ProcessEnv;
  private readonly idleMs: number;
  private readonly toolsTtlMs: number;

  constructor(private readonly o: RegistryOptions) {
    this.env = o.env ?? process.env;
    this.idleMs = o.idleMs ?? Number(process.env.WRONGFORGE_MCP_IDLE_MS ?? 5 * 60_000);
    this.toolsTtlMs = o.toolsTtlMs ?? Number(process.env.WRONGFORGE_MCP_TOOLS_TTL_MS ?? 60_000);
  }

  get store(): McpStore {
    return this.o.store;
  }

  // ---------------------------------------------------------------- config ops
  // (store + pool invalidation in one place, used by the API, the CLI and the agent tools)

  addServer(name: string, spec: unknown): { spec: NormalizedSpec; existed: boolean } {
    const r = this.o.store.put(name, spec);
    void this.invalidate(name);
    this.o.logger?.info("mcp.server_saved", { server: name, existed: r.existed, spec: redactSpec(r.spec) });
    return r;
  }

  removeServer(name: string): boolean {
    const removed = this.o.store.remove(name);
    void this.invalidate(name);
    if (removed) this.o.logger?.info("mcp.server_removed", { server: name });
    return removed;
  }

  setEnabled(name: string, enabled: boolean): NormalizedSpec | undefined {
    const r = this.o.store.setEnabled(name, enabled);
    void this.invalidate(name);
    return r;
  }

  importServers(doc: unknown, opts: { overwrite?: boolean } = {}): ImportResult {
    const r = this.o.store.import(doc, opts);
    for (const n of [...r.added, ...r.updated]) void this.invalidate(n);
    this.o.logger?.info("mcp.imported", { added: r.added, updated: r.updated, skipped: r.skipped, invalid: r.invalid });
    return r;
  }

  /** Configured servers with redacted specs and live status. */
  status(): { servers: McpServerStatus[]; errors: { name: string; error: string }[]; file: string } {
    const { servers, errors } = this.o.store.readAll();
    const out: McpServerStatus[] = [];
    for (const [name, spec] of servers) {
      const conn = [...this.pool.values()].find((c) => c.name === name);
      const info = conn?.client.getServerVersion();
      out.push({
        name,
        spec: redactSpec(spec),
        connected: Boolean(conn),
        ...(conn?.tools ? { tools_cached: conn.tools.defs.length } : {}),
        ...(this.lastError.has(name) ? { last_error: this.lastError.get(name) } : {}),
        ...(info ? { server_info: { name: info.name, version: info.version } } : {}),
      });
    }
    return { servers: out, errors, file: this.o.store.file };
  }

  // ---------------------------------------------------------------- connections

  private specKey(name: string, spec: NormalizedSpec): string {
    return `${name}\0${JSON.stringify(spec)}`;
  }

  private async acquire(name: string): Promise<Conn> {
    if (!isValidServerName(name)) throw new McpError("unknown_server", `invalid MCP server name "${name}"`);
    const spec = this.o.store.get(name);
    if (!spec) throw new McpError("unknown_server", `no MCP server named "${name}" is configured`);
    if (!spec.enabled) throw new McpError("server_disabled", `MCP server "${name}" is disabled`);

    const key = this.specKey(name, spec);
    const gen = this.gen; // captured before the suspension below
    // a changed config must not reuse an old connection
    for (const c of [...this.pool.values()]) if (c.name === name && c.key !== key && c.refs === 0) void this.drop(c);

    let conn = this.pool.get(key);
    if (!conn) {
      let p = this.connecting.get(key);
      if (!p) {
        p = this.connect(name, spec, key, gen).finally(() => this.connecting.delete(key));
        this.connecting.set(key, p);
      }
      conn = await p;
    }
    clearTimeout(conn.idle);
    conn.refs++;
    return conn;
  }

  private release(conn: Conn): void {
    conn.refs = Math.max(0, conn.refs - 1);
    if (conn.refs === 0 && this.pool.get(conn.key) === conn) {
      conn.idle = setTimeout(() => void this.drop(conn), this.idleMs);
      conn.idle.unref();
    }
  }

  private async drop(conn: Conn): Promise<void> {
    clearTimeout(conn.idle);
    if (this.pool.get(conn.key) === conn) this.pool.delete(conn.key);
    await conn.client.close().catch(() => undefined);
    this.o.logger?.debug("mcp.closed", { server: conn.name });
  }

  /** Closes the pooled connection(s) of a server (after its config changed). */
  async invalidate(name: string): Promise<void> {
    this.gen++; // a connect still in flight must not publish after this
    await Promise.all([...this.pool.values()].filter((c) => c.name === name).map((c) => this.drop(c)));
    this.lastError.delete(name);
  }

  async closeAll(): Promise<void> {
    this.gen++; // a connect still in flight must not publish after this
    await Promise.all([...this.pool.values()].map((c) => this.drop(c)));
  }

  private expandSpec(name: string, s: NormalizedSpec): NormalizedSpec {
    const x = (v: string, what: string): string => expandEnv(v, this.env, `server "${name}" ${what}`);
    const xm = (m: Record<string, string> | undefined, what: string): Record<string, string> | undefined =>
      m && Object.fromEntries(Object.entries(m).map(([k, v]) => [k, x(v, `${what}.${k}`)]));
    return {
      ...s,
      ...(s.url ? { url: x(s.url, "url") } : {}),
      ...(s.command ? { command: x(s.command, "command") } : {}),
      ...(s.args ? { args: s.args.map((a, i) => x(a, `args[${i}]`)) } : {}),
      ...(s.cwd ? { cwd: x(s.cwd, "cwd") } : {}),
      ...(s.headers ? { headers: xm(s.headers, "headers") } : {}),
      ...(s.env ? { env: xm(s.env, "env") } : {}),
    };
  }

  private async connect(name: string, spec: NormalizedSpec, key: string, gen: number): Promise<Conn> {
    const started = Date.now();
    const live = this.expandSpec(name, spec); // may throw McpConfigError (missing ${VAR})
    let transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport;
    // stdio servers log to stderr; node needs a real file descriptor for that,
    // so it goes to <config dir>/mcp-logs/<server>.stderr.log (overwritten on every connect)
    let stderrFile: string | undefined;
    let stderrFd: number | undefined;

    if (live.type === "stdio") {
      try {
        const logDir = path.join(path.dirname(this.o.store.file), "mcp-logs");
        fs.mkdirSync(logDir, { recursive: true });
        stderrFile = path.join(logDir, `${name}.stderr.log`);
        stderrFd = fs.openSync(stderrFile, "w");
      } catch {
        stderrFd = undefined; // diagnostics are optional
      }
      transport = new StdioClientTransport({
        command: live.command!,
        args: live.args,
        env: live.env,
        cwd: live.cwd,
        stderr: stderrFd ?? "ignore",
      });
    } else if (live.type === "http") {
      transport = new StreamableHTTPClientTransport(new URL(live.url!), {
        requestInit: { headers: live.headers },
      });
    } else {
      transport = new SSEClientTransport(new URL(live.url!), {
        requestInit: { headers: live.headers },
      });
    }

    const timeout = live.startup_timeout_ms;
    let client: Client | undefined;
    const c = new Client({ name: "wrongforge", version: "0.3.0" });
    try {
      await Promise.race([
        c.connect(transport),
        new Promise<never>((_, rej) => {
          const t = setTimeout(() => rej(new Error(`no answer within ${timeout} ms`)), timeout + 500);
          t.unref();
        }),
      ]);
      client = c;
    } catch (e) {
      // the transport has already spawned the child — release it, or a failed
      // connect leaks the process (and its stdio pipes) for the rest of our life
      await c.close().catch(() => undefined);
      let tail = "";
      if (stderrFile) {
        try {
          tail = fs.readFileSync(stderrFile, "utf8").trim();
        } catch {
          /* no log */
        }
      }
      const msg = `${(e as Error).message}${tail ? ` — server stderr: ${truncateMiddle(tail, 800)}` : ""}`;
      this.lastError.set(name, msg);
      this.o.logger?.warn("mcp.connect_failed", { server: name, type: live.type, error: msg });
      throw new McpError("mcp_unavailable", `cannot connect to MCP server "${name}": ${msg}`);
    } finally {
      // the child keeps its own copy of the descriptor
      if (stderrFd !== undefined) {
        try {
          fs.closeSync(stderrFd);
        } catch {
          /* already closed */
        }
      }
    }

    const conn: Conn = { name, key, spec, client, refs: 0 };
    // the registry may have been shut down (`closeAll`) or this server's config
    // replaced (`invalidate`) while we were connecting — drop instead of publishing
    if (gen !== this.gen) {
      await client!.close().catch(() => undefined);
      throw new McpError("mcp_unavailable", `MCP server "${name}" was closed or reconfigured while connecting`);
    }
    this.pool.set(key, conn);
    this.lastError.delete(name);
    const info = client.getServerVersion();
    this.o.logger?.info("mcp.connected", {
      server: name, type: live.type, duration_ms: Date.now() - started, server_info: info,
    });
    return conn;
  }

  // ---------------------------------------------------------------- discovery

  /** Tools of a server (cached for the TTL unless `refresh`). */
  async listTools(name: string, opts: { refresh?: boolean } = {}): Promise<McpToolDef[]> {
    const conn = await this.acquire(name);
    try {
      if (!opts.refresh && conn.tools && this.toolsTtlMs > 0 && Date.now() - conn.tools.at < this.toolsTtlMs) {
        return conn.tools.defs;
      }
      const defs: McpToolDef[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const res = await conn.client.listTools(cursor ? { cursor } : undefined);
        for (const t of res.tools) {
          defs.push({
            name: t.name,
            description: String(t.description ?? t.title ?? `Tool "${t.name}" of MCP server "${name}".`),
            schema: ((t.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} }),
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      conn.tools = { at: Date.now(), defs };
      return defs;
    } catch (e) {
      this.noteFailure(conn, e);
      throw new McpError("mcp_error", `listing the tools of "${name}" failed: ${(e as Error).message}`);
    } finally {
      this.release(conn);
    }
  }

  /** Connects, lists the tools and reports — never throws. */
  async test(name: string): Promise<McpTestResult> {
    const started = Date.now();
    try {
      await this.invalidate(name); // test from a clean connection
      const tools = await this.listTools(name, { refresh: true });
      const conn = [...this.pool.values()].find((c) => c.name === name);
      const info = conn?.client.getServerVersion();
      const instructions = conn?.client.getInstructions();
      return {
        ok: true,
        server_info: info ? { name: info.name, version: info.version } : undefined,
        ...(instructions ? { instructions: truncateMiddle(instructions, 2000) } : {}),
        tools: tools.map((t) => ({ name: t.name, description: t.description.slice(0, 200) })),
        duration_ms: Date.now() - started,
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message, tools: [], duration_ms: Date.now() - started };
    }
  }

  // ---------------------------------------------------------------- calling

  /** One tool call. Never throws: errors become `{ ok:false, error }`. */
  async callTool(
    name: string,
    tool: string,
    input: unknown,
    opts: { signal?: AbortSignal; timeoutMs?: number; taskId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const started = Date.now();
    let conn: Conn;
    try {
      conn = await this.acquire(name);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    // the server's allow/deny lists hold for every way of calling a tool (eager tools, mcp_call, API)
    const { allow, deny } = conn.spec;
    if ((allow?.length && !matches(allow, tool)) || (deny?.length && matches(deny, tool))) {
      this.release(conn);
      return { ok: false, error: `tool "${tool}" is not permitted by the allow/deny list of MCP server "${name}"` };
    }
    const timeout = opts.timeoutMs ?? conn.spec.timeout_ms;
    try {
      const res = await conn.client.callTool(
        {
          name: tool,
          arguments: (input && typeof input === "object" ? input : {}) as Record<string, unknown>,
        },
        undefined,
        { signal: opts.signal, timeout },
      );
      const mapped = mapCallResult(res);
      this.o.logger?.info("mcp.call", {
        task_id: opts.taskId, server: name, tool, ok: mapped.ok, duration_ms: Date.now() - started,
      });
      return mapped;
    } catch (e) {
      this.noteFailure(conn, e);
      const err = e as Error;
      const msg = opts.signal?.aborted
        ? "the call was cancelled"
        : /timed? ?out|timeout/i.test(err.message)
          ? `the call timed out after ${timeout} ms`
          : `MCP call failed: ${err.message}`;
      this.o.logger?.info("mcp.call", { task_id: opts.taskId, server: name, tool, ok: false, error: msg, duration_ms: Date.now() - started });
      return { ok: false, error: msg };
    } finally {
      this.release(conn);
    }
  }

  /** A dead connection must not stay in the pool. */
  private noteFailure(conn: Conn, e: unknown): void {
    const msg = (e as Error)?.message ?? String(e);
    this.lastError.set(conn.name, msg);
    if (/closed|not connected|EPIPE|ECONNRESET|ECONNREFUSED|socket hang up/i.test(msg)) void this.drop(conn);
  }

  // ---------------------------------------------------------------- eager tools

  /**
   * Builds the typed `mcp_<server>_<tool>` tools for a task.
   * `selection`: undefined = every enabled server that is `eager`;
   * ["*"] = every enabled server; otherwise exactly the named servers.
   * A selected server that cannot be reached is skipped with a warning —
   * unless it is `required`, then this throws McpError(mcp_unavailable).
   */
  async loadForTask(
    selection: string[] | undefined,
    ctx: { taskId: string },
    signal?: AbortSignal,
  ): Promise<McpLoadResult> {
    const { servers: all } = this.o.store.readAll();
    const warnings: string[] = [];
    let names: string[];
    if (selection === undefined) names = [...all].filter(([, s]) => s.enabled && s.eager).map(([n]) => n);
    else if (selection.includes("*")) names = [...all].filter(([, s]) => s.enabled).map(([n]) => n);
    else names = selection;

    const results = await Promise.all(
      names.map(async (name): Promise<{ load: McpServerLoad; defs: McpToolDef[] }> => {
        const spec = all.get(name);
        if (!spec) return { load: { name, ok: false, tools: 0, error: "not configured" }, defs: [] };
        if (!spec.enabled) return { load: { name, ok: false, tools: 0, error: "disabled" }, defs: [] };
        try {
          if (signal?.aborted) throw new Error("cancelled");
          const defs = await this.listTools(name);
          return { load: { name, ok: true, tools: defs.length }, defs };
        } catch (e) {
          return { load: { name, ok: false, tools: 0, error: (e as Error).message }, defs: [] };
        }
      }),
    );

    for (const r of results) {
      if (!r.load.ok) {
        warnings.push(`MCP server "${r.load.name}" skipped: ${r.load.error}`);
        if (all.get(r.load.name)?.required) {
          throw new McpError("mcp_unavailable", `required MCP server "${r.load.name}" is unavailable: ${r.load.error}`);
        }
      }
    }

    const reserved = this.o.reservedNames ?? new Set<string>();
    const seen = new Set<string>();
    const defs: McpLoadedDef[] = [];
    for (const r of results) {
      const spec = all.get(r.load.name);
      if (!r.load.ok || !spec) continue;
      for (const t of r.defs) {
        if (spec.allow?.length && !matches(spec.allow, t.name)) continue;
        if (spec.deny?.length && matches(spec.deny, t.name)) continue;
        let schema = t.schema;
        if (schema.type === undefined) schema = { type: "object", ...schema };
        if (schema.type !== "object") {
          warnings.push(`skipped ${r.load.name}/${t.name}: input schema is not an object`);
          continue;
        }
        if (schema.properties === undefined) schema = { ...schema, properties: {} };
        const exposed = exposedName(r.load.name, t.name);
        if (reserved.has(exposed) || seen.has(exposed)) {
          warnings.push(`skipped ${r.load.name}/${t.name}: the name "${exposed}" is already taken`);
          continue;
        }
        seen.add(exposed);
        defs.push({
          exposed, remote: t.name, server: r.load.name, schema,
          description: `[MCP ${r.load.name}] ${t.description}`.slice(0, 4000),
        });
      }
    }
    defs.sort((a, b) => a.exposed.localeCompare(b.exposed));
    const cap = this.o.maxEagerTools ?? 128;
    if (defs.length > cap) {
      warnings.push(`only the first ${cap} MCP tools are exposed individually (${defs.length} found); use mcp_tools + mcp_call for the rest, or narrow it with allow/deny or the task's "mcp" list`);
      defs.length = cap;
    }

    const tools: ToolSet = {};
    for (const d of defs) {
      const spec = all.get(d.server)!;
      tools[d.exposed] = dynamicTool({
        description: d.description,
        inputSchema: d.schema,
        execute: (input, options) =>
          this.callTool(d.server, d.remote, input, { signal: options?.abortSignal, timeoutMs: spec.timeout_ms, taskId: ctx.taskId }),
      });
    }
    return { tools, defs, servers: results.map((r) => r.load), hash: toolsHash(defs), warnings };
  }
}

// ----------------------------------------------------------------- results

interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

/** CallToolResult -> `{ ok, output | error }` for the model. Image content
 *  blocks ride as inline `images` on the output (messages.ts forwards them
 *  as API image blocks — the model sees MCP tool images, CC parity); types
 *  the API does not accept (audio) stay summarized. */
export function mapCallResult(res: unknown): Record<string, unknown> {
  const r = res as { content?: McpContentBlock[]; isError?: boolean; structuredContent?: unknown; toolResult?: unknown };
  const parts: string[] = [];
  const images: Array<{ media_type: string; data: string }> = [];
  for (const c of r?.content ?? []) {
    switch (c.type) {
      case "text":
        parts.push(c.text ?? "");
        break;
      case "image": {
        const mt = c.mimeType ?? "image/png";
        if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mt)) {
          images.push({ media_type: mt, data: c.data ?? "" });
          parts.push(`[image ${mt} attached]`);
        } else {
          parts.push(`[image ${mt}, ${Math.round(((c.data ?? "").length * 3) / 4)} bytes — unsupported by the API, not shown]`);
        }
        break;
      }
      case "audio":
        parts.push(`[audio ${c.mimeType ?? ""} — not shown]`);
        break;
      case "resource":
        parts.push(
          c.resource?.text !== undefined
            ? `[resource ${c.resource.uri ?? ""}]\n${c.resource.text}`
            : `[resource ${c.resource?.uri ?? ""} (${c.resource?.mimeType ?? "binary"}) — not shown]`,
        );
        break;
      case "resource_link":
        parts.push(`[resource link ${c.uri ?? ""}${c.name ? ` (${c.name})` : ""}]`);
        break;
      default:
        parts.push(JSON.stringify(c));
    }
  }
  let text = parts.join("\n");
  if (!text && r?.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
  if (!text && r?.toolResult !== undefined) text = JSON.stringify(r.toolResult);

  const truncated = text.length > MAX_OUTPUT_CHARS;
  if (truncated) text = truncateMiddle(text, MAX_OUTPUT_CHARS);
  if (r?.isError) return { ok: false, error: text || "the MCP tool reported an error" };
  return {
    ok: true,
    output: text,
    ...(images.length ? { images } : {}),
    ...(r?.structuredContent !== undefined && parts.length ? { structured: r.structuredContent } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// ---------------------------------------------------------------- singleton

let shared: McpRegistry | null = null;

/** Process-wide registry on the default config file (REPL, server, CLI share it). */
export function defaultMcpRegistry(logger?: Logger): McpRegistry {
  shared ??= new McpRegistry({ store: new McpStore(McpStore.defaultFile()), logger });
  return shared;
}

export { McpConfigError };
