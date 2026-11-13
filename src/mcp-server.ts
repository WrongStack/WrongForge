/**
 * WrongForge as an MCP server (stdio).
 *
 *   wrongforge mcp-server
 *
 * Exposes the task API as MCP tools, so any MCP client (Claude Code, Claude
 * Desktop, …) can drive WrongForge in natural language: submit a task, wait
 * for it, read the result, cancel it, list sessions of work, read usage.
 * The process is a thin stdio bridge — every tool call is an authenticated
 * HTTP request against a RUNNING WrongForge server:
 *
 *   WRONGFORGE_URL      server base URL   (default http://127.0.0.1:8787)
 *   WRONGFORGE_API_KEY  server API key    (default: the <data dir>/api-key file)
 *
 * Whatever key the bridge holds determines scoping: hand it a named client
 * key and Claude's submissions land in that client's scope (see the
 * "Multiple clients" section of TASKS-API.md).
 *
 * Low-level `Server` (not the zod-flavored McpServer wrapper) so the tool
 * schemas are plain JSON Schema — independent of the zod major in use.
 * Protocol stdio is sacred: nothing in this file may console.log to stdout.
 */

import * as fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { apiKeyFile } from "./apikey.js";
import { VERSION } from "./paths.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);

export interface McpBridgeOptions {
  url?: string;
  apiKey?: string;
}

export interface McpBridge {
  base: string;
  key: string;
}

/** Server URL + API key: env first, saved key file second. */
export function resolveMcpBridge(opts: McpBridgeOptions = {}): McpBridge {
  const base = (opts.url ?? process.env.WRONGFORGE_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const key =
    opts.apiKey ??
    process.env.WRONGFORGE_API_KEY ??
    (() => {
      try {
        return fs.readFileSync(apiKeyFile(), "utf8").trim() || undefined;
      } catch {
        return undefined;
      }
    })();
  if (!key) {
    throw new Error(
      `no WrongForge API key — set WRONGFORGE_API_KEY, or run the server once to create ${apiKeyFile()}`,
    );
  }
  return { base, key };
}

type JsonRpcContent = { type: "text"; text: string };

const asText = (value: unknown): { content: JsonRpcContent[] } => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});
const asError = (message: string): { content: JsonRpcContent[]; isError: true } => ({
  content: [{ type: "text", text: message }],
  isError: true,
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface ApiResult {
  status: number;
  body: any;
}

/** Registry of exposed tools — schema, docs and handler in one place. */
export function buildTools(bridge: McpBridge) {
  const api = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
    const res = await fetch(`${bridge.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bridge.key}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const detail = async (taskId: string): Promise<any> => (await api("GET", `/v1/tasks/${taskId}`)).body?.task ?? null;

  /** Polls a task to a terminal state; null result = the tool timeout hit. */
  const waitTask = async (taskId: string, timeoutMs: number): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const task = await detail(taskId);
      if (task && TERMINAL.has(task.status)) return task;
      if (Date.now() >= deadline) return null;
      await sleep(1000);
    }
  };

  const submit = async (a: Record<string, any>): Promise<{ content: JsonRpcContent[] }> => {
    const body: Record<string, unknown> = { prompt: a.prompt };
    for (const k of ["workdir", "session_id", "task_id", "model", "effort", "priority", "context", "system_append", "images"]) {
      if (a[k] !== undefined) body[k] = a[k];
    }
    for (const k of ["max_steps", "timeout_ms"]) if (a[k] !== undefined) body[k] = a[k];
    const r = await api("POST", "/v1/tasks", body);
    if (r.status !== 202 && r.status !== 200) {
      return asError(`submit failed (HTTP ${r.status}): ${r.body?.error?.message ?? JSON.stringify(r.body)}`);
    }
    const task = r.body.task;
    if (a.wait === true) {
      const final = await waitTask(task.id, 240_000);
      if (!final) return asText({ task, note: "still running after 240 s — poll get_task to follow it" });
      return asText(final);
    }
    return asText(task);
  };

  return [
    {
      name: "submit_task",
      description:
        "Submit a coding task to WrongForge (a Claude agent that runs in a working directory with bash/file tools). " +
        "Set wait=true to block until it finishes and get the result; without it you get the task id and can follow up with get_task / wait_task.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The instruction for the agent." },
          workdir: { type: "string", description: "Absolute working directory (required unless the server has a default)." },
          session_id: { type: "string", description: "Continue this session; omitted = new session." },
          task_id: { type: "string", description: "Your own id (idempotency key)." },
          model: { type: "string" },
          effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "off"] },
          priority: { type: "string", enum: ["low", "normal"], description: "low keeps the last concurrency slot free for interactive work." },
          max_steps: { type: "integer", maximum: 500 },
          timeout_ms: { type: "integer" },
          context: { type: "object", description: "Opaque JSON echoed back in the task document." },
          system_append: { type: "string" },
          images: {
            type: "array",
            description: "Image attachments (max 5, ≤ 5 MB each decoded; png/jpeg/gif/webp) the agent sees in its first message.",
            items: {
              type: "object",
              properties: {
                media_type: { type: "string", enum: ["image/png", "image/jpeg", "image/gif", "image/webp"] },
                data: { type: "string", description: "base64-encoded image bytes (no data: prefix)." },
              },
              required: ["media_type", "data"],
            },
          },
          wait: { type: "boolean", description: "true = wait up to 240 s for completion and return the final task document." },
        },
        required: ["prompt"],
      },
      run: submit,
    },
    {
      name: "get_task",
      description: "Status, progress and (when finished) the result of one task.",
      inputSchema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
      run: async (a: Record<string, any>) => {
        const task = await detail(a.task_id);
        return task ? asText(task) : asError(`no task "${a.task_id}"`);
      },
    },
    {
      name: "wait_task",
      description: "Block until a task reaches a terminal state (or the timeout) and return its document.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          timeout_ms: { type: "integer", default: 60_000, maximum: 300_000 },
        },
        required: ["task_id"],
      },
      run: async (a: Record<string, any>) => {
        const timeout = Math.min(300_000, Math.max(1000, Number(a.timeout_ms ?? 60_000)));
        const final = await waitTask(a.task_id, timeout);
        return final ? asText(final) : asError(`still running after ${timeout} ms — call wait_task again`);
      },
    },
    {
      name: "cancel_task",
      description: "Cancel a queued (immediately) or running (aborts the model call and shell commands) task.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, reason: { type: "string" } },
        required: ["task_id"],
      },
      run: async (a: Record<string, any>) => {
        const r = await api("POST", `/v1/tasks/${a.task_id}/cancel`, a.reason ? { reason: a.reason } : {});
        if (r.status === 404) return asError(`no task "${a.task_id}"`);
        if (r.status !== 200) return asError(`cancel failed (HTTP ${r.status})`);
        return asText(r.body);
      },
    },
    {
      name: "list_tasks",
      description: "Recent tasks (newest first), optionally filtered by status or session.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["queued", "running", "completed", "failed", "cancelled", "timed_out"] },
          session_id: { type: "string" },
          limit: { type: "integer", default: 20, maximum: 200 },
        },
      },
      run: async (a: Record<string, any>) => {
        const p = new URLSearchParams();
        if (a.status) p.set("status", a.status);
        if (a.session_id) p.set("session_id", a.session_id);
        p.set("limit", String(Math.min(200, Number(a.limit ?? 20))));
        const r = await api("GET", `/v1/tasks?${p}`);
        return asText(r.body);
      },
    },
    {
      name: "task_events",
      description: "Recent events of one task (steps, tool calls, agent text) — how you watch what the agent did.",
      inputSchema: {
        type: "object",
        properties: { task_id: { type: "string" }, limit: { type: "integer", default: 50, maximum: 1000 } },
        required: ["task_id"],
      },
      run: async (a: Record<string, any>) => {
        const r = await api("GET", `/v1/tasks/${a.task_id}/events?limit=${Math.min(1000, Number(a.limit ?? 50))}`);
        if (r.status !== 200) return asError(`no events for "${a.task_id}" (HTTP ${r.status})`);
        return asText(r.body);
      },
    },
    {
      name: "usage_summary",
      description: "Aggregated token usage over the last N days (totals, by day / client / model; fresh input = not served from cache).",
      inputSchema: { type: "object", properties: { days: { type: "integer", default: 7, maximum: 365 } } },
      run: async (a: Record<string, any>) => {
        const r = await api("GET", `/v1/usage/summary?days=${Math.min(365, Math.max(1, Number(a.days ?? 7)))}`);
        if (r.status !== 200) return asError(`usage summary failed (HTTP ${r.status})`);
        return asText(r.body);
      },
    },
    {
      name: "list_sessions",
      description: "Known conversation sessions (most recently updated first).",
      inputSchema: { type: "object", properties: { limit: { type: "integer", default: 20, maximum: 200 } } },
      run: async (a: Record<string, any>) => {
        const r = await api("GET", "/v1/sessions");
        if (r.status !== 200) return asError(`sessions failed (HTTP ${r.status})`);
        const sessions = (r.body?.sessions ?? []).slice(0, Math.min(200, Number(a.limit ?? 20)));
        return asText({ sessions });
      },
    },
  ];
}

/** Builds the MCP Server instance (exported for tests). */
export function buildMcpServer(bridge: McpBridge): Server {
  const tools = buildTools(bridge);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server({ name: "wrongforge", version: VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) return asError(`unknown tool "${req.params.name}"`);
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    try {
      return await tool.run(args);
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      // a network hiccup against the server is the common failure — say so
      return asError(`${message} (is the WrongForge server running at ${bridge.base}?)`);
    }
  });

  return server;
}

/** Entry for `wrongforge mcp-server`: serves MCP over stdio until the client closes stdin. */
export async function startMcpServer(opts: McpBridgeOptions = {}): Promise<void> {
  const bridge = resolveMcpBridge(opts);
  const server = buildMcpServer(bridge);
  await server.connect(new StdioServerTransport());
  // StdioServerTransport keeps the loop alive while the client is connected;
  // stdin closing (the client going away) tears the transport down with it.
  await new Promise<void>(() => undefined);
}
