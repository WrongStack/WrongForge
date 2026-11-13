/**
 * Unit tests for network-facing helpers: model list, provider fetch branches,
 * OAuth parsing, session repair, web fetching, the tool gateway and log
 * utilities — all against local mock HTTP servers, no real network.
 *
 *   npx tsx test/unit-net.test.ts
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { fetchModelList } from "../src/models.js";
import { createClaudeClient } from "../src/provider.js";
import { ClaudeOAuth, parsePastedCode } from "../src/oauth.js";
import { SessionStore, repairTail } from "../src/sessions.js";
import { toApiMessages, type AgentMessage } from "../src/messages.js";
import { runAgentTurn } from "../src/agent.js";
import { runInContext } from "../src/context.js";
import { runTool } from "../src/tool.js";
import { web_fetch } from "../src/tools/web-fetch.js";
import { htmlToText, isPrivateAddress } from "../src/tools/web-utils.js";
import { GatewayRegistry, validateGatewaySpec, allowedGatewayHosts, describeGateway, normalizeDefs } from "../src/tools/gateway.js";
import { gzipFile, sanitize } from "../src/log.js";
import type Anthropic from "@anthropic-ai/sdk";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-net-"));
// Refresh tests use local token endpoints and must not inherit a developer's
// OAuth configuration (a clean CI runner has no ~/.wrongforge/oauth.json).
process.env.WRONGFORGE_HOME = path.join(tmp, "home");
process.env.CLAUDE_OAUTH_CONFIG = path.join(tmp, "oauth-config.json");
process.env.CLAUDE_OAUTH_CLIENT_ID = "unit-net-client";
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

function listen(server: http.Server): Promise<number> {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r((server.address() as { port: number }).port)));
}

/** Minimal SSE /v1/messages responder driven by a script of stop reasons. */
function sseMessages(res: http.ServerResponse, opts: { text?: string; toolName?: string; inputTokens?: number }): void {
  const w = (obj: unknown) => res.write(`event: ${String((obj as { type: string }).type)}\ndata: ${JSON.stringify(obj)}\n\n`);
  w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: opts.inputTokens ?? 5, output_tokens: 1 } } });
  if (opts.toolName) {
    w({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu1", name: opts.toolName, input: {} } });
    w({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
    w({ type: "content_block_stop", index: 0 });
  } else {
    w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: opts.text ?? "hi" } });
    w({ type: "content_block_stop", index: 0 });
  }
  w({ type: "message_delta", delta: { stop_reason: opts.toolName ? "tool_use" : "end_turn" }, usage: { output_tokens: 2 } });
  w({ type: "message_stop" });
  res.end();
}

async function main(): Promise<void> {
  // ======================================================== models list
  const modelsServer = http.createServer((req, res) => {
    const page = req.url?.includes("after_id=p1") ? 2 : 1;
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        page === 1
          ? JSON.stringify({ data: [{ type: "model", id: "m-a", display_name: "A", created_at: "2026-01-02" }, { type: "junk" }], has_more: true, last_id: "p1" })
          : JSON.stringify({ data: [{ type: "model", id: "m-b", display_name: "B", created_at: "2026-03-04" }], has_more: false }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  const modelsPort = await listen(modelsServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${modelsPort}`;

  const moauth = new ClaudeOAuth(path.join(tmp, "models-tokens.json"));
  const ccFile = path.join(tmp, "cc1.json");
  fs.writeFileSync(ccFile, JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
  moauth.importFromClaudeCode(ccFile);
  const models = await fetchModelList(moauth);
  assert(models.ok && models.models.map((m) => m.id).join(",") === "m-b,m-a", "fetchModelList paginates, sorts, filters");
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${modelsPort}/v1`;
  const models2 = await fetchModelList(moauth);
  assert(models2.ok && models2.models.length === 2, "fetchModelList tolerates /v1 suffix");

  const errServer = http.createServer((_req, res) => res.writeHead(500).end("nope"));
  const errPort = await listen(errServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${errPort}`;
  const bad = await fetchModelList(moauth);
  assert(!bad.ok && bad.error.includes("500"), "fetchModelList error path");

  // ======================================================== provider: API-key path
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const apiServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      seen.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/v1/oauth/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "fresh-at", refresh_token: "fresh-rt", expires_in: 3600, scope: "user:inference" }));
        return;
      }
      if (req.url?.startsWith("/v1/messages")) {
        sseMessages(res, {});
        return;
      }
      res.writeHead(404).end();
    });
  });
  const apiPort = await listen(apiServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${apiPort}`;

  process.env.ANTHROPIC_API_KEY = "sk-ant-test-1234567890";
  const keyClient = createClaudeClient(moauth);
  const keyDone = await keyClient.messages.stream({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] }).finalMessage();
  assert(seen.at(-1)?.headers["x-api-key"] === "sk-ant-test-1234567890", "api-key path sends x-api-key");
  // SDK 1.x sends Bearer for apiKey clients too; we keep x-api-key alongside
  // (dual header — whichever acceptance behavior the endpoint has) with the
  // SAME key, so the bearer value is the key itself, not an OAuth token
  assert(seen.at(-1)?.headers["authorization"] === "Bearer sk-ant-test-1234567890", "api-key path bearer carries the key itself (dual header, SDK 1.x)");
  assert(keyDone.type === "message", "api-key client roundtrip");
  delete process.env.ANTHROPIC_API_KEY;

  // oauth path: bearer + metadata.user_id injected + billing header blocks
  const oauthClient = createClaudeClient(moauth);
  const hist: AgentMessage[] = [{ role: "user", content: "hi" }];
  const turn = await runAgentTurn(oauthClient, "m", hist, 2);
  assert(turn.finishReason === "end_turn" && turn.text === "hi", "oauth path turn");
  const msgReq = seen.find((s) => s.url.startsWith("/v1/messages") && s.body?.metadata);
  assert(msgReq, "metadata injected");
  assert(typeof msgReq!.body.metadata.user_id === "string" && msgReq!.body.metadata.user_id.length > 0, "user_id present");
  assert(String(msgReq!.headers["authorization"]).startsWith("Bearer "), "bearer injected");
  assert(msgReq!.body.system?.[0]?.text?.startsWith("x-anthropic-billing-header:"), "billing header first system block");
  assert(msgReq!.url.includes("beta=true"), "beta=true query");

  // F1401: context_tokens must include cached input — with prompt caching the
  // API's `input_tokens` is only the uncached tail, so ignoring the cache
  // components made a ~900k-token session report ~1k and auto-compaction
  // could never fire.
  {
    const cacheUsage = {
      input_tokens: 84,
      output_tokens: 960,
      cache_read_input_tokens: 900_000,
      cache_creation_input_tokens: 0,
    };
    const cacheEvents = [
      { type: "message_start", message: { usage: cacheUsage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 960 } },
      { type: "message_stop" },
    ];
    const cacheClient = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            for (const ev of cacheEvents) yield ev;
          },
          async finalMessage() {
            return { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: cacheUsage };
          },
        }),
      },
    } as unknown as Anthropic;
    const cacheTurn = await runAgentTurn(cacheClient, "m", [{ role: "user", content: "hi" }] as AgentMessage[], 1);
    assert(
      cacheTurn.context_tokens >= 900_000,
      `F1401: context_tokens includes cached input (got ${cacheTurn.context_tokens}, cache_read ${cacheUsage.cache_read_input_tokens})`,
    );
  }

  // 401 → refresh → retry
  let oauthState = 0;
  const authServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/v1/oauth/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: `at-${oauthState}`, refresh_token: "rt", expires_in: 3600, scope: "user:inference" }));
        return;
      }
      oauthState++;
      if (oauthState === 1) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "expired" } }));
      } else {
        sseMessages(res, { text: "after-refresh" });
      }
    });
  });
  const authPort = await listen(authServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${authPort}`;
  const tokenUrlBak = process.env.ANTHROPIC_TOKEN_URL;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${authPort}/v1/oauth/token`;
  const moauth2 = new ClaudeOAuth(path.join(tmp, "t2.json"));
  fs.writeFileSync(ccFile, JSON.stringify({ claudeAiOauth: { accessToken: "stale", refreshToken: "rt", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));
  moauth2.importFromClaudeCode(ccFile);
  const h2: AgentMessage[] = [{ role: "user", content: "hi" }];
  const t2 = await runAgentTurn(createClaudeClient(moauth2), "m", h2, 2);
  assert(t2.text === "after-refresh" && oauthState === 2, "401 triggers refresh and retry");

  // API error surfaces as turn error without throwing
  const failServer = http.createServer((_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
  });
  const failPort = await listen(failServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${failPort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${failPort}/v1/oauth/token`;
  const events: string[] = [];
  const t3 = await runAgentTurn(createClaudeClient(moauth2), "m", [{ role: "user", content: "x" }], 2, undefined, (e) => {
    if (e.type === "error") events.push(e.error);
  });
  assert(t3.finishReason === "error" && events.some((e) => e.includes("slow down")), "api error -> error event + finish=error");

  // context guard fires when usage reports a big context
  let guardStep = 0;
  const guardServer = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    guardStep++;
    if (guardStep === 1) sseMessages(res, { inputTokens: 10_000_000, toolName: "ls" });
    else sseMessages(res, { inputTokens: 10_000_000, text: "big" });
  });
  const guardPort = await listen(guardServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${guardPort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${guardPort}/v1/oauth/token`;
  const gh: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "old", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "old", toolName: "bash", output: "x".repeat(50) }] },
  ];
  let clearedEvent = false;
  await runAgentTurn(createClaudeClient(moauth2), "m", gh, 3, undefined, (e) => {
    if (e.type === "context_cleared") clearedEvent = true;
  }, undefined, { clearAt: 1, keepToolResults: 0 });
  assert(clearedEvent, "context guard clears old tool outputs");

  // unknown tool -> tool_error event; circular output survives summarize
  let toolStep = 0;
  const toolServer = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    toolStep++;
    if (toolStep === 1) sseMessages(res, { toolName: "definitely_not_a_tool" });
    else sseMessages(res, { text: "done" });
  });
  const toolPort = await listen(toolServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${toolPort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${toolPort}/v1/oauth/token`;
  const toolEvents: string[] = [];
  const t4 = await runAgentTurn(createClaudeClient(moauth2), "m", [{ role: "user", content: "x" }], 2, undefined, (e) => {
    if (e.type === "tool_error") toolEvents.push(e.error);
    if (e.type === "tool_call") toolEvents.push("call");
  });
  assert(t4.toolCalls === 1 && t4.finishReason === "end_turn" && toolEvents.includes("call") && toolEvents.includes("unknown tool"), "unknown tool -> tool_error");

  // abort mid-stream -> finishReason aborted
  const slowServer = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`);
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "sla" } })}\n\n`);
    // never message_stop — hangs until aborted
  });
  const slowPort = await listen(slowServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${slowPort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${slowPort}/v1/oauth/token`;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const t5 = await runAgentTurn(createClaudeClient(moauth2), "m", [{ role: "user", content: "x" }], 2, ac.signal);
  assert(t5.finishReason === "aborted", "abort mid-stream -> aborted");

  // ======================================================== oauth parsing
  assert(parsePastedCode("https://cb?code=abc&state=st", "st") === "abc", "parsePastedCode url");
  assert(parsePastedCode("xyz#st", "st") === "xyz", "parsePastedCode hash form");
  assert(parsePastedCode("plain", "st") === "plain", "parsePastedCode raw");
  let threw = "";
  try {
    parsePastedCode("https://cb?code=", "st");
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("empty"), "parsePastedCode empty throws");
  threw = "";
  try {
    parsePastedCode("https://cb?code=a&state=other", "st");
  } catch (e) {
    threw = (e as Error).message;
  }
  assert(threw.includes("state mismatch"), "parsePastedCode state mismatch");
  let importErr = "";
  try {
    new ClaudeOAuth(path.join(tmp, "t3.json")).importFromClaudeCode(path.join(tmp, "nope.json"));
  } catch (e) {
    importErr = (e as Error).message;
  }
  assert(importErr.includes("cannot read"), "import missing file");
  const badCreds = path.join(tmp, "bad.json");
  fs.writeFileSync(badCreds, JSON.stringify({ claudeAiOauth: {} }));
  importErr = "";
  try {
    new ClaudeOAuth(path.join(tmp, "t4.json")).importFromClaudeCode(badCreds);
  } catch (e) {
    importErr = (e as Error).message;
  }
  assert(importErr.includes("no claudeAiOauth.accessToken"), "import without token");
  assert(importErr.includes(badCreds), "missing-token error identifies the credentials file");
  fs.writeFileSync(badCreds, "{broken-json");
  try {
    new ClaudeOAuth(path.join(tmp, "malformed-token.json")).importFromClaudeCode(badCreds);
    throw new Error("expected malformed credentials to fail");
  } catch (e) {
    assert((e as Error).message.includes("not valid JSON") && (e as Error).message.includes(badCreds), "malformed JSON is distinguished from an unreadable file");
  }
  fs.writeFileSync(badCreds, "\uFEFF" + JSON.stringify({ claudeAiOauth: { accessToken: "bom-token", expiresAt: Date.now() + 3600_000 } }));
  const bomOauth = new ClaudeOAuth(path.join(tmp, "bom-token.json"));
  bomOauth.importFromClaudeCode(badCreds);
  assert(await bomOauth.getAccessToken() === "bom-token", "UTF-8 BOM credentials import successfully");
  const cleared = new ClaudeOAuth(path.join(tmp, "t5.json"));
  cleared.importFromClaudeCode(ccFile);
  cleared.clear?.();
  assert(true, "clear tolerated");

  // ======================================================== sessions
  const sdir = path.join(tmp, "sessions");
  const store = new SessionStore(sdir);
  store.create("s1");
  const full: AgentMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "answer" },
  ];
  store.appendTurn("s1", full, { task_id: "t", model: "m", prompt: "p", workdir: "/w", context_tokens: 5 });
  store.appendTurn("s1", full, { task_id: "t2", model: "m", prompt: "p", workdir: "/w", context_tokens: 6 });
  const loaded = store.load("s1")!;
  assert(loaded.messages.length === 4 && loaded.meta.turns === 2, "appendTurn accumulates");
  const page1 = store.page("s1", 0, 2)!;
  assert(page1.total === 4 && page1.messages.length === 2, "page slices");
  const rep = await store.replaceMessages("s1", [{ role: "user", content: "trimmed" }]);
  assert(rep.meta.message_count === 1 && fs.existsSync(rep.archive), "replaceMessages archives");
  assert(repairTail([...full, { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "n", input: {} }] }]).length === 2, "repairTail drops dangling tool-call");
  assert(repairTail(full).length === 2, "repairTail keeps complete tail");
  store.create("s2");
  const s2meta = path.join(sdir, "s2", "session.json");
  const old = JSON.parse(fs.readFileSync(s2meta, "utf8"));
  old.updated_at = new Date(Date.now() - 10 * 86_400_000).toISOString();
  fs.writeFileSync(s2meta, JSON.stringify(old));
  const pruned = store.prune(5, new Date(), new Set());
  assert(pruned.includes("s2") && !pruned.includes("s1"), "prune removes only old idle sessions");

  // F603: appendTurn() must repair a dangling tool-call tail BEFORE writing,
  // the same way load()/page() already repair one on read — otherwise
  // message_count silently drifts from what every future load() returns
  // (and GET /v1/sessions serializes that counter straight to callers).
  store.create("f603-danger");
  const danglingTurn: AgentMessage[] = [
    { role: "user", content: "run two tools" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_1", toolName: "bash", input: { command: "echo hi" } },
        { type: "tool-call", toolCallId: "call_2", toolName: "bash", input: { command: "echo bye" } },
      ],
    },
    // no tool-result message follows — simulates a turn whose tool loop was
    // interrupted between appending the assistant's tool_use blocks and
    // recording their results.
  ];
  const f603meta = store.appendTurn("f603-danger", danglingTurn, { task_id: "f603-t1", model: "m", prompt: "run two tools" });
  const f603loaded = store.load("f603-danger")!;
  assert(f603meta.message_count === f603loaded.messages.length, "F603: message_count matches load() after a dangling-tail turn");
  assert(f603loaded.messages.length === 1 && f603loaded.messages[0]!.role === "user", "F603: only the user message survived");
  const f603raw = fs.readFileSync(path.join(sdir, "f603-danger", "messages.jsonl"), "utf8");
  assert(!f603raw.includes("call_1"), "F603: the dangling tool-call never reached disk");
  // a turn that is ONLY a dangling tail writes nothing and still counts the turn
  store.create("f603-only-dangling");
  const onlyDangling: AgentMessage[] = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "call_3", toolName: "read", input: {} }] }];
  const f603metaOnly = store.appendTurn("f603-only-dangling", onlyDangling, { task_id: "f603-t2", model: "m", prompt: "p" });
  assert(f603metaOnly.message_count === 0 && f603metaOnly.turns === 1, "F603: an all-dangling turn writes nothing but still counts as a turn");
  // a complete tool-call/tool-result turn is untouched (no false-positive repair)
  store.create("f603-healthy");
  const completeTurn: AgentMessage[] = [
    { role: "user", content: "run one tool" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_4", toolName: "bash", input: { command: "ls" } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "call_4", toolName: "bash", output: { type: "text", value: "ok" } }] },
  ];
  const f603metaHealthy = store.appendTurn("f603-healthy", completeTurn, { task_id: "f603-t3", model: "m", prompt: "run one tool" });
  assert(f603metaHealthy.message_count === 3 && store.load("f603-healthy")!.messages.length === 3, "F603: a complete tool-call/tool-result turn is never touched");

  // messages string branches
  assert(toApiMessages([{ role: "assistant", content: "plain" }])[0].content[0].type === "text", "assistant string content");
  assert(toApiMessages([{ role: "assistant", content: "" }]).length === 0, "assistant empty string skipped");

  // ======================================================== log utilities
  const circ: Record<string, unknown> = { a: 1 };
  circ.self = circ;
  const s = sanitize(circ, 100) as Record<string, unknown>;
  assert(typeof s.a === "number" && (s.self === "[Circular]" || typeof s.self === "string"), "sanitize circular");
  const src = path.join(tmp, "g.txt");
  fs.writeFileSync(src, "gzip me");
  const gz = await gzipFile(src);
  assert(gunzipSync(fs.readFileSync(gz)).toString() === "gzip me", "gzipFile roundtrip");

  // ======================================================== web fetch + utils
  assert(isPrivateAddress("10.0.0.1") && isPrivateAddress("192.168.1.1") && isPrivateAddress("127.0.0.1") && !isPrivateAddress("8.8.8.8"), "isPrivateAddress");
  const html = "<html><head><title>T</title><style>x</style><script>bad()</script></head><body><h1>H</h1><p>hello<br>world</p></body></html>";
  const webServer = http.createServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(html);
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/page" });
      res.end();
    } else {
      res.writeHead(404).end("gone");
    }
  });
  const webPort = await listen(webServer);
  process.env.WRONGFORGE_ALLOW_PRIVATE_URLS = "1"; // test-only bypass of the public-address rule
  const fetched = await runTool(web_fetch, { url: `http://127.0.0.1:${webPort}/page` }, {});
  assert(fetched.ok && String((fetched.output as { text: string }).text).includes("hello"), "web_fetch html -> text");
  assert((fetched.output as { title: string | null }).title === "T", "web_fetch extracts title");
  const redirected = await runTool(web_fetch, { url: `http://127.0.0.1:${webPort}/redirect` }, {});
  assert(redirected.ok && (redirected.output as { text: string }).text.includes("hello"), "web_fetch follows redirect");
  const capped = await runTool(web_fetch, { url: `http://127.0.0.1:${webPort}/page`, max_chars: 3 }, {});
  assert((capped.output as { truncated: boolean }).truncated === true, "web_fetch max_chars truncates");
  const notFound = await runTool(web_fetch, { url: `http://127.0.0.1:${webPort}/nope` }, {});
  assert(notFound.ok && (notFound.output as { ok: boolean; status: number }).ok === false && (notFound.output as { status: number }).status === 404, "web_fetch 404 reported in body");
  delete process.env.WRONGFORGE_ALLOW_PRIVATE_URLS;
  const priv = await runTool(web_fetch, { url: "http://169.254.169.254/latest/meta-data" }, {});
  assert(priv.ok && (priv.output as { ok: boolean; error?: string }).ok === false && (priv.output as { error?: string }).error?.includes("blocked:"), "web_fetch blocks private address before making a request");
  const ht = htmlToText("<p>a</p><script>x</script>");
  assert(ht.text.includes("a") && !ht.text.includes("x"), "htmlToText strips scripts");

  // ======================================================== gateway
  const gwEnv = { WRONGFORGE_GATEWAY_ALLOWED_HOSTS: "Example.com, trusted.local" };
  assert(allowedGatewayHosts(gwEnv).join(",") === "example.com,trusted.local", "allowedGatewayHosts env list");
  assert(allowedGatewayHosts({}).includes("127.0.0.1"), "allowedGatewayHosts loopback default");
  let gwErr = "";
  try {
    validateGatewaySpec({ url: "http://evil.example" }, ["good.example"]);
  } catch (e) {
    gwErr = (e as Error).message;
  }
  assert(gwErr.length > 0, "validateGatewaySpec rejects foreign host");
  const spec = validateGatewaySpec({ url: "http://good.example/api", token: "t" }, ["good.example"]);
  assert(spec.url === "http://good.example/api", "validateGatewaySpec accepts listed host");
  const info = describeGateway(spec);
  assert(info.has_token && !info.inline, "describeGateway secrets-free");
  const gwSpecForDefs = { url: "http://x.example", deny: ["grep", "fetch*"] } as ReturnType<typeof validateGatewaySpec>;
  const defs = normalizeDefs(
    [
      { name: "b", description: "B", input_schema: { type: "object" } },
      { name: "a", description: "A", input_schema: { type: "object" } },
      { name: "a", description: "A2", input_schema: { type: "object" } },
      { name: "bad" },
      { name: "wrongtype", input_schema: { type: "string" } },
      { name: "defaults", input_schema: {} },
      { name: "bash", input_schema: { type: "object" } },
      { name: "grep", description: "G", input_schema: { type: "object" } },
      { name: "fetch_url", description: "F", input_schema: { type: "object" } },
      42,
    ],
    gwSpecForDefs,
    new Set(["wstack_bash"]),
  );
  assert(defs.defs.map((d) => d.exposed).join(",") === "wstack_a,wstack_b,wstack_bad,wstack_defaults", "normalizeDefs sorts + dedupes + filters");
  assert(!defs.defs.some((d) => d.remote === "grep"), "normalizeDefs deny skips denied tools");
  assert(!defs.defs.some((d) => d.remote === "fetch_url"), "normalizeDefs deny skips wildcard-denied tools");
  assert(defs.warnings.some((w) => w.includes("without a name")) && defs.warnings.some((w) => w.includes("duplicate")), "normalizeDefs warnings");
  const allowedDefs = normalizeDefs(
    [
      { name: "alpha", description: "AL", input_schema: { type: "object" } },
      { name: "beta", description: "BE", input_schema: { type: "object" } },
      { name: "adelete", description: "AD", input_schema: { type: "object" } },
    ],
    { url: "http://x.example", allow: ["a*"], deny: ["adelete"] } as ReturnType<typeof validateGatewaySpec>,
    new Set(),
  );
  assert(allowedDefs.defs.map((d) => d.exposed).join(",") === "wstack_alpha", "normalizeDefs allow skips non-matching tools");
  assert(!allowedDefs.defs.some((d) => d.remote === "adelete"), "normalizeDefs deny wins over allow on a both-matching tool");

  // gateway discovery + call against a mock orchestrator
  const gwCalls: Record<string, unknown>[] = [];
  const gwServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      gwCalls.push({ m: req.method, u: req.url, body });
      if (req.url === "/tools") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ tools: [{ name: "alpha", description: "does alpha", input_schema: { type: "object" } }] }));
      } else if (req.url === "/tools/alpha/call") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, output: { done: true } }));
      } else {
        res.writeHead(404).end();
      }
    });
  });
  const gwPort = await listen(gwServer);
  const reg = new GatewayRegistry({ reservedNames: new Set() });
  const gwSpec2 = validateGatewaySpec({ url: `http://127.0.0.1:${gwPort}`, name_prefix: "wstack_" }, ["127.0.0.1"]);
  const loaded2 = await reg.load(gwSpec2, new AbortController().signal);
  assert(loaded2.defs.length === 1 && loaded2.defs[0].exposed === "wstack_alpha", "gateway discovery exposes prefixed tools");
  assert(Object.keys(loaded2.tools).includes("wstack_alpha"), "gateway builds toolset");
  const callRes = await reg.call(loaded2.defs[0], gwSpec2, { taskId: "t" } as never, { x: 1 }, "call-1");
  assert((callRes as { ok: boolean }).ok === true, "gateway call roundtrip");
  const last = gwCalls.at(-1)!;
  assert(last.u === "/tools/alpha/call" && (last.body as { input: unknown }).input, "gateway call posts input");

  // F1001: the discovery cache must never grow without bound — its key
  // includes the gateway's token/headers, so a distinct per-task token (a
  // realistic orchestrator pattern) would otherwise add one entry per task
  // for the whole life of a long-running server.
  const fakeDiscoveryFetch = (async () =>
    new Response(JSON.stringify({ tools: [{ name: "x", description: "x", input_schema: { type: "object", properties: {} } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  const gatewayCacheReg = new GatewayRegistry({ reservedNames: new Set(), fetchImpl: fakeDiscoveryFetch, discoveryTtlMs: 0 });
  const gatewayCacheCtx = { taskId: "t", sessionId: "s", workdir: "/w" };
  for (let i = 0; i < 800; i++) {
    await gatewayCacheReg.load({ url: "http://127.0.0.1:1/orchestrator", token: `task-token-${i}` }, gatewayCacheCtx);
  }
  const gatewayCacheSize = (gatewayCacheReg as unknown as { cache: Map<string, unknown> }).cache.size;
  assert(gatewayCacheSize <= 500, `F1001: gateway discovery cache stays bounded (size=${gatewayCacheSize}) across 800 distinct per-task tokens`);

  // cache_control rejection -> retried once without markers, then disabled
  let cacheStep = 0;
  const cacheServer = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    cacheStep++;
    if (cacheStep === 1) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "cache_control ttl is not supported" } }));
    } else {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (cacheStep === 2 && JSON.stringify(body.system).includes("cache_control")) {
          res.writeHead(400).end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "still has cache_control" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}
data: ${JSON.stringify(o)}

`);
        w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } });
        w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "nocache" } });
        w({ type: "content_block_stop", index: 0 });
        w({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
        w({ type: "message_stop" });
        res.end();
      });
    }
  });
  const cachePort = await listen(cacheServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cachePort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${cachePort}/v1/oauth/token`;
  const cOauth = new ClaudeOAuth(path.join(tmp, "cache-tokens.json"));
  cOauth.importFromClaudeCode(ccFile);
  const cRun = await runAgentTurn(createClaudeClient(cOauth), "m", [{ role: "user", content: "x" }], 2);
  assert(cRun.text === "nocache" && cacheStep === 2, "cache_control rejected -> retried clean");
  cacheServer.close();

  // cache_control rejection is scoped to the SESSION that triggered it, not
  // the whole process — a different session must keep sending cache_control.
  let sessionCacheStep = 0;
  const sessionCacheBodies: any[] = [];
  const sessionCacheServer = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    sessionCacheStep++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      sessionCacheBodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (sessionCacheStep === 1) {
        // session A's first attempt: reject cache_control
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "cache_control ttl is not supported" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}\ndata: ${JSON.stringify(o)}\n\n`);
      w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } });
      w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      w({ type: "content_block_stop", index: 0 });
      w({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      w({ type: "message_stop" });
      res.end();
    });
  });
  const sessionCachePort = await listen(sessionCacheServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${sessionCachePort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${sessionCachePort}/v1/oauth/token`;
  const scOauth = new ClaudeOAuth(path.join(tmp, "session-cache-tokens.json"));
  scOauth.importFromClaudeCode(ccFile);
  const scClient = createClaudeClient(scOauth);

  await runInContext({ cwd: ".", env: {}, todos: [], cache: "1h", sessionId: "ses-A" }, () =>
    runAgentTurn(scClient, "m", [{ role: "user", content: "x" }], 2),
  );
  assert(JSON.stringify(sessionCacheBodies[0]).includes("cache_control"), "session A's rejected first attempt still included cache_control");
  assert(!JSON.stringify(sessionCacheBodies[1]).includes("cache_control"), "session A's retry dropped it after the rejection");

  await runInContext({ cwd: ".", env: {}, todos: [], cache: "1h", sessionId: "ses-A" }, () =>
    runAgentTurn(scClient, "m", [{ role: "user", content: "x" }], 2),
  );
  assert(!JSON.stringify(sessionCacheBodies.at(-1)).includes("cache_control"), "session A stays off on a later, unrelated call");

  await runInContext({ cwd: ".", env: {}, todos: [], cache: "1h", sessionId: "ses-B" }, () =>
    runAgentTurn(scClient, "m", [{ role: "user", content: "x" }], 2),
  );
  assert(JSON.stringify(sessionCacheBodies.at(-1)).includes("cache_control"), "a DIFFERENT session is unaffected by session A's rejection");
  sessionCacheServer.close();

  // effort rejection -> retried once without the field, and only for that model
  const effortBodies: any[] = [];
  const effortServer = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      effortBodies.push(body);
      if (body.model === "m-noeffort" && body.output_config?.effort !== undefined) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "effort: Extra inputs are not permitted" } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}\ndata: ${JSON.stringify(o)}\n\n`);
      w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } });
      w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "effok" } });
      w({ type: "content_block_stop", index: 0 });
      w({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } });
      w({ type: "message_stop" });
      res.end();
    });
  });
  const effortPort = await listen(effortServer);
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${effortPort}`;
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${effortPort}/v1/oauth/token`;
  const eOauth = new ClaudeOAuth(path.join(tmp, "effort-tokens.json"));
  eOauth.importFromClaudeCode(ccFile);
  const e1 = await runAgentTurn(createClaudeClient(eOauth), "m-noeffort", [{ role: "user", content: "x" }], 2);
  assert(e1.text === "effok" && effortBodies.length === 2, "effort rejected -> retried once without it");
  assert(effortBodies[0].output_config?.effort === "high" && effortBodies[1].output_config?.effort === undefined, "first body carries output_config.effort, the retry drops it");
  const e2 = await runAgentTurn(createClaudeClient(eOauth), "m-capable", [{ role: "user", content: "x" }], 2);
  assert(e2.text === "effok" && effortBodies[2].output_config?.effort === "high", "a different model keeps its effort after the rejection");
  effortServer.close();

  // cleanup servers
  for (const s of [modelsServer, errServer, apiServer, authServer, failServer, guardServer, toolServer, slowServer, webServer, gwServer]) s.close();
  if (tokenUrlBak) process.env.ANTHROPIC_TOKEN_URL = tokenUrlBak;

  console.log("UNIT NET TESTS PASSED ✓ (models, provider branches, oauth parsing, sessions, web, gateway)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
