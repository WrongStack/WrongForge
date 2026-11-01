/**
 * Unit tests for the small core modules: compaction, cache breakpoints,
 * message conversion, tool runner, OAuth config, paths, banner, task prompts,
 * plan usage and maintenance.
 *
 *   npx tsx test/unit-core.test.ts
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { mock } from "node:test";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  clearOldToolOutputs,
  compactMessages,
  contextConfigFromEnv,
  estimateTokens,
  isCacheOrderingError,
  isContextOverflow,
  renderTranscript,
  splitTurns,
  truncateToolOutput,
  CLEARED_PLACEHOLDER,
} from "../src/compaction.js";
import { applyCacheBreakpoints, defaultCacheMode } from "../src/cache.js";
import {
  applyEffortToBody,
  clampEffort,
  defaultEffort,
  effectiveEffort,
  effortCap,
  effortRejectedOnce,
  effortSupport,
  initEffortPersistence,
  isEffortSetting,
  lowerEffort,
  markEffortRejected,
  noteEffortCap,
  resetEffortRejections,
  resolveEffort,
  sessionEffort,
  setSessionEffort,
} from "../src/effort.js";
import { fromApiAssistantMessage, toApiMessages, type AgentMessage } from "../src/messages.js";
import { dynamicTool, runTool, tool } from "../src/tool.js";
import { configHelp, configFilePath, loadOAuthConfig } from "../src/config.js";
import { dataDir } from "../src/paths.js";
import { renderBanner, printBanner } from "../src/banner.js";
import { runInContext } from "../src/context.js";
import { toApiInputSchema } from "../src/tools/util.js";
import { startLiveView } from "../src/liveview.js";
import { buildTaskPreamble, buildTaskSystemPrompt, loadPromptFiles, promptDir } from "../src/prompt.js";
import { fetchPlanUsage, untilLabel, usageLine } from "../src/usage.js";
import { retentionFromEnv, runMaintenance, startMaintenance } from "../src/maintenance.js";
import type { MaintenanceDeps } from "../src/maintenance.js";
import { Logger } from "../src/log.js";
import { ClaudeOAuth } from "../src/oauth.js";
import { TaskStore } from "../src/tasks/store.js";
import { SessionStore } from "../src/sessions.js";
import type Anthropic from "@anthropic-ai/sdk";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-unit-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

async function main(): Promise<void> {
  // ======================================================== compaction
  const msgs: AgentMessage[] = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "a", toolName: "bash", input: {} }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "a", toolName: "bash", output: "out1" }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ];
  assert(splitTurns(msgs).length === 2, "splitTurns: user starts a turn");
  assert(splitTurns([]).length === 0, "splitTurns: empty");

  const cleared = clearOldToolOutputs(msgs, 0);
  assert(cleared.cleared === 1 && cleared.messages !== msgs, "clearOldToolOutputs clears");
  assert(
    (cleared.messages[2] as { content: { output: { value: string } }[] }).content[0].output.value === CLEARED_PLACEHOLDER,
    "clearOldToolOutputs placeholder",
  );
  const recleared = clearOldToolOutputs(cleared.messages, 0);
  assert(recleared.cleared === 0 && recleared.messages === cleared.messages, "clearOldToolOutputs is idempotent");
  assert(clearOldToolOutputs(msgs, 5).messages === msgs, "clearOldToolOutputs keeps recent");

  const transcript = renderTranscript([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi\nthere" },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "x", toolName: "read", input: { p: 1 } }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "x", toolName: "read", output: { ok: true } }] },
  ]);
  assert(transcript.includes("USER: hello") && transcript.includes("ASSISTANT: hi"), "renderTranscript user/assistant");
  assert(transcript.includes("[tool call] read") && transcript.includes("[tool result] read"), "renderTranscript tools");
  const huge: AgentMessage[] = [{ role: "user", content: "x".repeat(700_000) }];
  assert(renderTranscript(huge, 1000).includes("chars omitted from the middle"), "renderTranscript clips middle");

  const fakeClient = {
    messages: {
      create: async () => ({ content: [{ type: "text", text: "  the summary  " }] }),
    },
  } as unknown as Anthropic;
  assert((await compactMessages(fakeClient, "m", msgs, 2)) === null, "compactMessages: nothing to summarize yet");
  const compacted = await compactMessages(fakeClient, "m", msgs, 1);
  assert(compacted?.summary === "the summary" && compacted.messages[0].role === "user", "compactMessages result");
  const emptyClient = { messages: { create: async () => ({ content: [] }) } } as unknown as Anthropic;
  let threw = false;
  try {
    await compactMessages(emptyClient, "m", msgs, 1);
  } catch {
    threw = true;
  }
  assert(threw, "compactMessages: empty summary throws");

  // F1402: a summary that cannot fit the 4k budget no longer bricks the
  // session — the summarizer escalates ONCE to a 64k budget, and if even that
  // hits max_tokens a mechanical recovery (explicit placeholder + archived
  // originals) runs instead of throwing forever. The truncated summary text
  // is never installed (F602's invariant).
  const calls: number[] = [];
  const escalateClient = {
    messages: {
      create: async (params: { max_tokens: number }) => {
        calls.push(params.max_tokens);
        const fits = params.max_tokens >= 64_000;
        return {
          stop_reason: fits ? "end_turn" : "max_tokens",
          content: [{ type: "text", text: fits ? "real summary" : "truncat" }],
        };
      },
    },
  } as unknown as Anthropic;
  const escalated = await compactMessages(escalateClient, "m", msgs, 1);
  assert(
    escalated?.summary === "real summary" && calls.join(",") === "4000,64000",
    `compactMessages: escalates once to a 64k budget when 4000 cannot fit (calls: ${calls.join(",")})`,
  );
  const neverFits = {
    messages: {
      create: async () => ({ stop_reason: "max_tokens", content: [{ type: "text", text: "truncat" }] }),
    },
  } as unknown as Anthropic;
  const recovered = await compactMessages(neverFits, "m", msgs, 1);
  assert(
    recovered !== null && recovered.summary === "" && JSON.stringify(recovered.messages).includes("archived"),
    "compactMessages: an unsummarizable session recovers mechanically — no throw, no truncated summary installed",
  );

  const cfg = contextConfigFromEnv({
    WRONGFORGE_CONTEXT_WINDOW: "2000",
    WRONGFORGE_COMPACT_AT: "0",
    WRONGFORGE_CLEAR_AT: "bad",
    WRONGFORGE_COMPACT_KEEP_TURNS: "0",
    WRONGFORGE_KEEP_TOOL_RESULTS: "3",
    WRONGFORGE_MAX_TOOL_OUTPUT_CHARS: "500",
    WRONGFORGE_SUMMARY_MODEL: "x",
  });
  assert(cfg.window === 2000 && cfg.compactAt === 0 && cfg.clearAt === 600_000 && cfg.keepTurns === 1 && cfg.maxToolResultChars === 500, "contextConfigFromEnv clamps");
  assert(contextConfigFromEnv({}).maxToolResultChars === 400_000, "contextConfigFromEnv: maxToolResultChars default");
  assert(isContextOverflow("prompt is too long") && !isContextOverflow("nope"), "isContextOverflow");
  assert(
    isCacheOrderingError("a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block.") && !isCacheOrderingError("nope"),
    "isCacheOrderingError",
  );

  // ------------------------------------------------- session cache_mode lock
  {
    const csessions = new SessionStore(path.join(tmp, "cache-mode-sessions"));
    csessions.create("ses-lock");
    csessions.appendTurn("ses-lock", [], { task_id: "t1", model: "m", prompt: "p", cache_mode: "1h" });
    assert(csessions.meta("ses-lock")?.cache_mode === "1h", "appendTurn records cache_mode on the first turn");
    csessions.appendTurn("ses-lock", [], { task_id: "t2", model: "m", prompt: "p", cache_mode: "5m" });
    assert(csessions.meta("ses-lock")?.cache_mode === "1h", "a later turn's cache_mode never overwrites the locked value");
    const cunset = new SessionStore(path.join(tmp, "cache-mode-sessions-2"));
    cunset.create("ses-nomode");
    cunset.appendTurn("ses-nomode", [], { task_id: "t1", model: "m", prompt: "p" });
    assert(cunset.meta("ses-nomode")?.cache_mode === undefined, "appendTurn without cache_mode leaves it unset");
  }

  // ------------------------------------------------- per-result output cap
  const small = truncateToolOutput("short", 1000);
  assert(!small.truncated && small.output === "short" && small.originalChars === 5, "truncateToolOutput: under the limit passes through unchanged");
  const bigString = "x".repeat(10_000);
  const clippedString = truncateToolOutput(bigString, 1000);
  assert(clippedString.truncated && clippedString.originalChars === 10_000, "truncateToolOutput: over-limit string is truncated, original size reported");
  assert(
    typeof clippedString.output === "string" && (clippedString.output as string).length < 10_000 && (clippedString.output as string).includes("chars omitted"),
    "truncateToolOutput: clipped output is shorter and notes what happened",
  );
  const bigObject = { data: "y".repeat(10_000) };
  const clippedObject = truncateToolOutput(bigObject, 1000);
  assert(clippedObject.truncated && typeof clippedObject.output === "string", "truncateToolOutput: a non-string result is serialized before clipping");
  assert(truncateToolOutput(bigString, 0).truncated === false, "truncateToolOutput: maxChars<=0 disables truncation");
  assert(truncateToolOutput(bigString, 0).originalChars === 10_000, "truncateToolOutput: originalChars is still reported when disabled");
  assert(estimateTokens(400) === 100 && estimateTokens(1) === 1 && estimateTokens(0) === 0, "estimateTokens: chars/4 rounded up");

  // ======================================================== cache breakpoints
  const bodyStr = { system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }] };
  assert(applyCacheBreakpoints(bodyStr, "1h") === 2, "breakpoints: string content converted");
  assert((bodyStr.messages[0].content as { cache_control?: { ttl?: string } }[])[0].cache_control?.ttl === "1h", "breakpoints: 1h ttl");
  const bodyEmpty = { system: [{ type: "text", text: "" }], messages: [{ role: "user", content: [{ type: "text", text: "" }] }] };
  assert(applyCacheBreakpoints(bodyEmpty, "5m") === 0, "breakpoints: empty text not marked");
  assert(applyCacheBreakpoints({}, "off") === 0 && applyCacheBreakpoints(null, "5m") === 0, "breakpoints: off / null");
  const bodyKeep = { system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] };
  assert(applyCacheBreakpoints(bodyKeep, "5m") === 2, "breakpoints: existing markers kept");

  // an already-established ttl anywhere in the body (a proxy client's own
  // earlier turn, buried in history) pins every NEW marker to match it —
  // never introduces a second, conflicting ttl in one request (that's
  // exactly what Anthropic rejects outright)
  const bodyPinned5m = {
    system: [{ type: "text", text: "s" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "old turn", cache_control: { type: "ephemeral" } }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "new turn" },
    ],
  };
  applyCacheBreakpoints(bodyPinned5m, "1h"); // server mode is 1h, but the conversation already established 5m
  assert(
    (bodyPinned5m.messages[2].content as { cache_control?: { ttl?: string } }[])[0].cache_control?.ttl === undefined,
    "breakpoints: an established 5m ttl pins the new message marker to 5m even though mode=1h",
  );
  assert(
    (bodyPinned5m.system[0] as { cache_control?: { ttl?: string } }).cache_control?.ttl === undefined,
    "breakpoints: the system block's first-ever marker also honors the pinned 5m ttl",
  );

  const bodyPinned1h = {
    system: [{ type: "text", text: "s" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "old turn", cache_control: { type: "ephemeral", ttl: "1h" } }] },
      { role: "assistant", content: "ok" },
      { role: "user", content: "new turn" },
    ],
  };
  applyCacheBreakpoints(bodyPinned1h, "5m"); // server mode is 5m, but the conversation already established 1h
  assert(
    (bodyPinned1h.messages[2].content as { cache_control?: { ttl?: string } }[])[0].cache_control?.ttl === "1h",
    "breakpoints: an established 1h ttl pins the new message marker to 1h even though mode=5m",
  );

  assert(defaultCacheMode({ WRONGFORGE_CACHE: "5m" }) === "5m", "defaultCacheMode: reads WRONGFORGE_CACHE");
  assert(defaultCacheMode({ WRONGFORGE_CACHE: "bogus" }) === "1h", "defaultCacheMode: falls back to 1h on an invalid value");
  assert(defaultCacheMode({}) === "1h", "defaultCacheMode: falls back to 1h when unset");

  // ======================================================== messages conversion
  assert(toApiMessages([{ role: "user", content: "" }]).length === 0, "toApiMessages: empty string skipped");
  assert(toApiMessages([{ role: "assistant", content: [] }]).length === 0, "toApiMessages: empty parts skipped");
  assert(toApiMessages([{ role: "tool", content: [] }]).length === 0, "toApiMessages: empty tool msg skipped");
  const api = toApiMessages([
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash", input: undefined }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "t1", toolName: "bash", output: { a: 1 } }] },
  ]);
  assert((api[0].content[0] as { input: object }).input !== undefined, "toApiMessages: nullish input becomes {}");
  assert((api[1].content[0] as { content: string }).content === '{"a":1}', "toApiMessages: object output stringified");
  const back = fromApiAssistantMessage([{ type: "text", text: "hi" }, { type: "tool_use", id: "u", name: "n", input: { x: 1 } }]);
  assert(back.role === "assistant" && back.content.length === 2, "fromApiAssistantMessage round shape");

  // ======================================================== tool runner
  const echo = tool({
    description: "echo",
    inputSchema: z.object({ v: z.string() }),
    execute: async (i) => i.v,
  });
  assert((await runTool(echo, { v: "ok" }, {})).output === "ok", "runTool: zod path");
  const bad = await runTool(echo, { v: 42 }, {});
  assert(bad.ok === false && bad.error.length > 0, "runTool: validation failure");
  assert((await runTool(undefined, {}, {})).ok === false, "runTool: unknown tool");
  const dyn = dynamicTool({ description: "d", inputSchema: { type: "object" }, execute: async (i) => i });
  assert((await runTool(dyn, { any: true }, {})).ok === true, "runTool: raw schema passthrough");

  // ======================================================== oauth config
  const home1 = path.join(tmp, "no-config");
  fs.mkdirSync(home1);
  {
    process.env.WRONGFORGE_HOME = home1;
    delete process.env.CLAUDE_OAUTH_CLIENT_ID;
    delete process.env.CLAUDE_OAUTH_CONFIG;
    assert(loadOAuthConfig() === null, "loadOAuthConfig: null without client id");
    assert(configHelp().includes("CLAUDE_OAUTH_CLIENT_ID"), "configHelp text");
    process.env.CLAUDE_OAUTH_CLIENT_ID = "env-id";
    process.env.CLAUDE_OAUTH_AUTHORIZE_URL = "https://a.example";
    const c = loadOAuthConfig()!;
    assert(c.clientId === "env-id" && c.authorizeUrl === "https://a.example" && c.tokenUrl.includes("platform.claude.com"), "loadOAuthConfig: env wins, defaults fill");
    delete process.env.CLAUDE_OAUTH_CLIENT_ID;
    delete process.env.CLAUDE_OAUTH_AUTHORIZE_URL;
    const file = path.join(home1, "oauth.json");
    fs.writeFileSync(file, JSON.stringify({ clientId: "file-id", tokenUrl: "https://t.example" }));
    assert(configFilePath().endsWith("oauth.json"), "configFilePath under home");
    const c2 = loadOAuthConfig()!;
    assert(c2.clientId === "file-id" && c2.tokenUrl === "https://t.example", "loadOAuthConfig: file values");
    process.env.CLAUDE_OAUTH_CONFIG = path.join(home1, "missing.json");
    assert(loadOAuthConfig() === null, "loadOAuthConfig: missing file via env path");
    delete process.env.CLAUDE_OAUTH_CONFIG;
  }

  // ======================================================== paths (legacy migration)
  const home2 = path.join(tmp, "legacy-home");
  const legacyDir = path.join(home2, ".wrongminiagent");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "marker.txt"), "x");
  {
    process.env.WRONGFORGE_HOME = home2 + "/.wrongforge"; // absent → triggers copy? no: explicit home wins
    delete process.env.WRONGFORGE_HOME;
    const osHomeBackup = process.env.USERPROFILE;
    // point homedir detection at home2 by faking os.homedir is not possible
    // without import; instead exercise the WRONGFORGE_HOME fast path only.
    process.env.WRONGFORGE_HOME = path.join(home2, "direct");
    assert(dataDir() === path.join(home2, "direct"), "dataDir: WRONGFORGE_HOME wins");
    process.env.WRONGFORGE_HOME = "";
    delete process.env.WRONGFORGE_HOME;
    void osHomeBackup;
  }

  // ======================================================== banner
  const key = { key: "sk-test-123456789", source: "env" as const };
  const banner = renderBanner(
    { version: "1.2.3", host: "127.0.0.1", port: 1234, key, signedIn: true, model: "m1", dataDir: "/d",
      logDir: "/l", maxConcurrency: 2, promptFiles: ["a.md"], defaultWorkdir: "/w", mcpServers: 1, recoveredTasks: 0 },
    true,
  );
  assert(banner.includes("1.2.3") && banner.includes("1234") && banner.includes("m1"), "renderBanner color, all fields");
  assert(banner.includes("a.md") && banner.includes("/w"), "renderBanner optional fields");
  const plain = renderBanner({ version: "0", host: "localhost", port: 1, key, signedIn: false, model: "m", dataDir: "/d" });
  assert(!plain.includes("\x1b["), "renderBanner plain");
  const gen = renderBanner({ version: "0", host: "::1", port: 1, key: { key: "k", source: "generated", file: "/f" }, signedIn: false, model: "m", dataDir: "/d" });
  assert(gen.includes("NEW") && gen.includes("[::1]"), "renderBanner generated key + ipv6 host");
  const fileKey = renderBanner({ version: "0", host: "h", port: 1, key: { key: "k", source: "file", file: "/f" }, signedIn: false, model: "m", dataDir: "/d" });
  assert(fileKey.includes("reused"), "renderBanner file-key note");
  const logged: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logged.push(String(a[0]));
  printBanner({ version: "0", host: "h", port: 1, key, signedIn: false, model: "m", dataDir: "/d" });
  console.log = origLog;
  assert(logged.length > 0, "printBanner writes");

  // ======================================================== prompts
  const pdir = path.join(tmp, "prompts");
  fs.mkdirSync(pdir);
  fs.writeFileSync(path.join(pdir, "b.md"), "guide b");
  fs.writeFileSync(path.join(pdir, "a.md"), "guide a");
  fs.writeFileSync(path.join(pdir, "_skip.md"), "no");
  fs.writeFileSync(path.join(pdir, "README.md"), "no");
  fs.writeFileSync(path.join(pdir, "empty.md"), "   ");
  const files = loadPromptFiles(pdir);
  assert(files.length === 2 && files[0].name === "a.md", "loadPromptFiles filters + sorts");
  assert(loadPromptFiles(path.join(tmp, "nope")).length === 0, "loadPromptFiles missing dir");
  process.env.WRONGFORGE_PROMPT_DIR = pdir;
  assert(promptDir() === pdir, "promptDir env override");
  delete process.env.WRONGFORGE_PROMPT_DIR;
  assert(buildTaskPreamble({ taskId: "t9", cwd: "/w" }).includes("task_id: t9"), "buildTaskPreamble");
  const sys = buildTaskSystemPrompt({ promptDir: pdir, systemAppend: " extra " });
  assert(sys.includes("## Guide: a") && sys.includes("## Additional instructions") && sys.includes("extra"), "buildTaskSystemPrompt");
  assert(!buildTaskSystemPrompt({ promptDir: pdir, systemAppend: "  " }).includes("Additional"), "systemAppend blank ignored");

  // ======================================================== usage (fake endpoint)
  let hits = 0;
  const usageServer = http.createServer((req, res) => {
    hits++;
    if (req.url === "/api/oauth/usage") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          five_hour: { utilization: 55, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          limits: [
            { kind: "session", group: "session", percent: 55, resets_at: new Date(Date.now() + 3600_000).toISOString(), is_active: true },
            { kind: "weekly_scoped", group: "weekly", percent: 10, resets_at: new Date(Date.now() + 86_400_000).toISOString(), is_active: true },
          ],
          extra_usage: { is_enabled: false },
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => usageServer.listen(0, "127.0.0.1", r));
  const uport = (usageServer.address() as { port: number }).port;
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${uport}`;
  // oauth with a fake token endpoint so getAccessToken never refreshes
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${uport}/v1/oauth/token`;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "cov";
  const uoauth = new ClaudeOAuth(path.join(tmp, "usage-tokens.json"));
  uoauth.importFromClaudeCode;
  // seed a valid stored token by faking CC credentials
  const ccFile = path.join(tmp, "cc-creds.json");
  fs.writeFileSync(ccFile, JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
  uoauth.importFromClaudeCode(ccFile);

  const u1 = await fetchPlanUsage(uoauth, { force: true });
  assert(u1 && u1.fiveHour.percent === 55 && u1.weekly?.percent === 10, "fetchPlanUsage parses windows");
  assert(usageLine(u1).includes("5h session 55%"), "usageLine summary");
  const before = hits;
  await fetchPlanUsage(uoauth);
  assert(hits === before, "fetchPlanUsage cached");
  await fetchPlanUsage(uoauth, { force: true });
  assert(hits === before + 1, "fetchPlanUsage force refetches");
  assert(untilLabel(null) === "unknown" && untilLabel("not-a-date") === "unknown", "untilLabel invalid");
  assert(untilLabel(new Date(Date.now() + 90 * 60_000).toISOString()) === "1h 30m", "untilLabel formats");

  // fallback shape: no limits[] → five_hour projection only
  const usageServer2 = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ five_hour: { utilization: 7, resets_at: null } }));
  });
  await new Promise<void>((r) => usageServer2.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(usageServer2.address() as { port: number }).port}`;
  const u2 = await fetchPlanUsage(uoauth, { force: true });
  assert(u2 && u2.fiveHour.percent === 7 && u2.weekly === null, "fetchPlanUsage five_hour fallback");

  // non-ok → null
  const usageServer3 = http.createServer((_req, res) => res.writeHead(500).end());
  await new Promise<void>((r) => usageServer3.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(usageServer3.address() as { port: number }).port}`;
  assert((await fetchPlanUsage(uoauth, { force: true })) === null, "fetchPlanUsage non-ok → null");
  // network refusal → null (closed port)
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:1";
  assert((await fetchPlanUsage(uoauth, { force: true })) === null, "fetchPlanUsage network error → null");
  usageServer.close();
  usageServer2.close();
  usageServer3.close();

  // ======================================================== maintenance
  const mhome = path.join(tmp, "maint");
  fs.mkdirSync(mhome, { recursive: true });
  const mlog = new Logger({ dir: path.join(mhome, "logs") });
  const mtasks = new TaskStore(path.join(mhome, "tasks"));
  const msessions = new SessionStore(path.join(mhome, "sessions"));
  const mret = retentionFromEnv({ WRONGFORGE_MAINTENANCE_INTERVAL_MIN: "0", WRONGFORGE_SESSION_RETENTION_DAYS: "1" });
  assert(mret.intervalMinutes === 0 && mret.sessionDeleteAfterDays === 1, "retentionFromEnv");
  const summary = await runMaintenance({
    logger: mlog,
    taskStore: mtasks,
    sessions: msessions,
    retention: mret,
    now: () => new Date(),
  });
  assert(summary.duration_ms >= 0 && summary.sessions_deleted.length === 0, "runMaintenance happy path");

  // failing stores → error branches, still a summary
  const failing = {
    dir: path.join(mhome, "logs"),
    currentFile: () => "x",
    error: () => undefined,
    info: () => undefined,
  } as unknown as Logger;
  const failTasks = { maintain: async () => { throw new Error("boom"); } } as unknown as TaskStore;
  const failSessions = { prune: () => { throw new Error("boom"); } } as unknown as SessionStore;
  const summary2 = await runMaintenance({ logger: failing, taskStore: failTasks, sessions: failSessions, retention: mret });
  assert(summary2.logs !== undefined, "runMaintenance tolerates store failures");
  const stop = startMaintenance({ logger: mlog, taskStore: mtasks, sessions: msessions, retention: { ...mret, intervalMinutes: 30 } });
  stop();
  assert(true, "startMaintenance returns stopper");

  // F703: a tick must never start a pass while one is still running — two
  // overlapping passes compress the same log into the same <file>.gz.tmp.
  // Ordering comes from a latch (pass 1 is parked in taskStore.maintain), not
  // from sleeps; advance the scheduler clock explicitly.
  {
    let entered = 0;
    let maxConcurrent = 0;
    let release: (() => void) | null = null;
    let started!: () => void;
    const first = new Promise<void>((r) => {
      started = r;
    });
    const parked = {
      maintain: async () => {
        entered++;
        maxConcurrent = Math.max(maxConcurrent, entered);
        started();
        await new Promise<void>((r) => {
          release = r;
        });
        entered--;
        return { compressed: [], deleted: [], errors: [] };
      },
    } as unknown as TaskStore;
    const deps = { logger: mlog, taskStore: parked, sessions: msessions, retention: retentionFromEnv({ WRONGFORGE_MAINTENANCE_INTERVAL_MIN: "0.002" }) };
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const stopFast = startMaintenance(deps);
    try {
      mock.timers.tick(120);
      await first;
      mock.timers.tick(500); // several scheduler ticks while the pass is parked
      assert(maxConcurrent === 1, `maintenance: overlapping passes (${maxConcurrent} in flight)`);
      // Stop future ticks BEFORE releasing the pass. Otherwise a legitimate
      // second pass may start during the old test's 100ms sleep and park again.
      stopFast();
      const finished = runMaintenance(deps); // join the already-running pass
      release?.();
      await finished;
      assert(entered === 0, `maintenance: parked pass released (entered=${entered})`);
    } finally {
      stopFast();
      mock.timers.reset();
    }
  }

  // F931: `runMaintenance` is reachable from outside the scheduler —
  // `POST /v1/maintenance/run` passes a fresh deps literal — so the in-flight guard
  // has to live in the pass itself. Two overlapping passes fight over the same
  // `<file>.gz.tmp` and one of them dies on the rename, so a pass that did its work
  // reports a failure. Ordering is synchronous (both passes are started in the same
  // tick and both reach createWriteStream before any I/O completes), no sleeps.
  {
    const oh = path.join(tmp, "maint-overlap");
    const odir = path.join(oh, "logs");
    fs.mkdirSync(odir, { recursive: true });
    const ofile = path.join(odir, "forge-2026-10-01.jsonl");
    const oline = JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", level: "info", event: "test.record", pad: "x".repeat(200) });
    fs.writeFileSync(ofile, Array.from({ length: 4000 }, () => oline).join("\n") + "\n");
    const original = fs.readFileSync(ofile);
    const oldWhen = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(ofile, oldWhen, oldWhen);
    const olog = new Logger({ dir: odir });
    const otasks = new TaskStore(path.join(oh, "tasks"));
    const osessions = new SessionStore(path.join(oh, "sessions"));
    const odeps = (): MaintenanceDeps => ({
      logger: olog, taskStore: otasks, sessions: osessions,
      retention: retentionFromEnv({ WRONGFORGE_LOG_COMPRESS_AFTER_DAYS: "1", WRONGFORGE_LOG_RETENTION_DAYS: "0" }),
      now: () => new Date(),
    });
    const [p1, p2] = await Promise.all([runMaintenance(odeps()), runMaintenance(odeps())]);
    const oerrs = [...p1.logs.errors, ...p2.logs.errors];
    assert(oerrs.length === 0, `maintenance: overlapping passes report no error (got ${oerrs.length}: ${JSON.stringify(oerrs)})`);
    assert(fs.existsSync(ofile + ".gz"), "maintenance: the overlapping pair produced the archive");
    assert(gunzipSync(fs.readFileSync(ofile + ".gz")).equals(original), "maintenance: the archive is byte-identical to the original");
    // the guard is not sticky: a later pass really runs again
    const p3 = await runMaintenance(odeps());
    assert(p3.logs.compressed.length === 0 && p3.logs.errors.length === 0, "maintenance: the next pass runs cleanly");
  }

  // ================================================================ effort
  {
    assert(defaultEffort({}) === "high", "default effort is high");
    assert(defaultEffort({ WRONGFORGE_EFFORT: "low" }) === "low", "env effort override");
    assert(defaultEffort({ WRONGFORGE_EFFORT: " HIGH " }) === "high", "env effort is trimmed/case-folded");
    assert(defaultEffort({ WRONGFORGE_EFFORT: "turbo" }) === "high", "invalid env effort falls back to high");
    assert(isEffortSetting("off") && isEffortSetting("medium") && !isEffortSetting("turbo") && !isEffortSetting(3), "effort setting validation");

    // the capability table mirrors CC 2.1.300's Vme list (re/carved): every
    // family from 3-5/3-7 through the 5.x lineup is effort-capable
    assert(effortSupport("claude-sonnet-5-5").length === 5, "5.x family supports every level incl. xhigh/max");
    assert(effortSupport("claude-opus-5-5").includes("max"), "opus 5.5 is effort-capable (Vme)");
    assert(effortSupport("claude-fable-5-1").includes("high"), "fable 5.x supports high");
    assert(effortSupport("claude-haiku-4-5-20251001").length === 5, "4.5 family supports every level");
    assert(effortSupport("claude-sonnet-4-20250514").length === 5, "sonnet 4.0 is effort-capable (in Vme)");
    assert(effortSupport("claude-opus-4-1-20250805").length === 5, "opus 4.1 is effort-capable (in Vme)");
    assert(effortSupport("claude-3-5-sonnet-20241022").length === 5, "3.5/3.7 are effort-capable (in Vme)");
    assert(effortSupport("claude-3-opus-20240229").length === 0, "the pre-3.5 3.x era has no effort");
    assert(effortSupport("claude-3-sonnet-20240229").length === 0, "bare 3.0 sonnet has no effort");
    assert(effortSupport("claude-2-1").length === 0, "2.x has no effort");
    assert(effortSupport("claude-future-9").length === 5, "unknown models are assumed effort-capable");

    assert(resolveEffort("high", "claude-sonnet-5-5").effort === "high", "supported level passes through");
    assert(resolveEffort("xhigh", "claude-sonnet-5-5").effort === "xhigh", "xhigh passes through on capable models");
    assert(resolveEffort("off", "claude-sonnet-5-5").effort === null, "off omits the field");
    const none = resolveEffort("high", "claude-3-opus");
    assert(none.effort === null && none.unsupported, "effort-incapable model omits the field");
    assert(clampEffort("high", ["low", "medium"]) === "medium", "clamp picks the nearest level below");
    assert(clampEffort("low", ["medium", "high"]) === "medium", "clamp picks the nearest level above");
    assert(clampEffort("medium", ["low", "high"]) === "low", "clamp tie prefers the cheaper level");
    assert(clampEffort("max", ["low", "medium", "high", "xhigh"]) === "xhigh", "clamp caps max at xhigh");

    setSessionEffort("low");
    assert(sessionEffort() === "low", "session effort set");
    setSessionEffort(null);
    assert(sessionEffort() === null, "session effort cleared");

    // learned effort CAPS (F2101, findings.md §21): an org-admin cap answers
    // "Invalid effort level" — the parameter is fine, the level is too high;
    // the learned ceiling clamps future requests instead of disabling effort
    resetEffortRejections();
    assert(lowerEffort("medium") === "low" && lowerEffort("low") === null, "lowerEffort walks the ladder and stops at the bottom");
    noteEffortCap("claude-sonnet-5-5", "medium");
    assert(effortCap("claude-sonnet-5-5") === "medium" && effortCap("claude-opus-5-5") === null, "the cap is per model");
    assert(effectiveEffort("claude-sonnet-5-5") === "medium", "a request above the cap clamps down to it");
    assert(effectiveEffort("claude-sonnet-5-5", { WRONGFORGE_EFFORT: "xhigh" }) === "medium", "any setting above the cap clamps");
    runInContext({ cwd: process.cwd(), env: {}, todos: [], effort: "high" }, () => {
      assert(effectiveEffort("claude-sonnet-5-5") === "medium", "the cap also clamps a task-level effort override");
    });
    assert(effectiveEffort("claude-sonnet-5-5", { WRONGFORGE_EFFORT: "low" }) === "low", "a setting below the cap passes through");
    resetEffortRejections();
    assert(effortCap("claude-sonnet-5-5") === null && effectiveEffort("claude-sonnet-5-5") === "high", "reset forgets learned caps");

    // runtime learning: a model the API refused effort for opts out, others keep it
    resetEffortRejections();
    markEffortRejected("claude-sonnet-5-5");
    assert(effortRejectedOnce("claude-sonnet-5-5") && !effortRejectedOnce("claude-opus-5-5"), "a learned rejection is per model");
    assert(effectiveEffort("claude-sonnet-5-5") === "off", "the rejected model omits effort");
    assert(effectiveEffort("claude-opus-5-5") === "high", "other models keep the default effort");
    markEffortRejected();
    assert(effortRejectedOnce("claude-opus-5-5"), "a rejection without a model id disables effort everywhere");
    resetEffortRejections();
    assert(!effortRejectedOnce("claude-sonnet-5-5") && effectiveEffort("claude-sonnet-5-5") === "high", "reset forgets the learned rejections");

    // persistence: rejections learned with a wired file survive a "restart"
    // (reload), stay per-model, and expire — so serve restarts stop re-paying
    // the probe for models the API already refused
    {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-effort-")), "effort-rejections.json");
      initEffortPersistence(file);
      markEffortRejected("claude-opus-5-5");
      assert(fs.existsSync(file), "a learned rejection is written to disk");
      resetEffortRejections();
      assert(!effortRejectedOnce("claude-opus-5-5"), "reset clears memory");
      initEffortPersistence(file); // what a serve restart does
      assert(effortRejectedOnce("claude-opus-5-5") && effectiveEffort("claude-opus-5-5") === "off", "a restart remembers the learned rejection");
      assert(effectiveEffort("claude-sonnet-5-5") === "high", "the memory stays per model");
      // an expired entry is dropped on load
      fs.writeFileSync(file, JSON.stringify({ version: 1, rejected: { "claude-opus-5-5": Date.now() - 8 * 24 * 3600 * 1000 } }));
      initEffortPersistence(file);
      assert(!effortRejectedOnce("claude-opus-5-5"), "rejections expire after a week");
      // caps persist the same way (and an old version-1 file without caps loads fine)
      noteEffortCap("claude-sonnet-5-5", "medium");
      assert(Array.isArray(JSON.parse(fs.readFileSync(file, "utf8")).caps["claude-sonnet-5-5"]), "a learned cap is written to disk (with a timestamp)");
      resetEffortRejections();
      initEffortPersistence(file);
      assert(effectiveEffort("claude-sonnet-5-5") === "medium", "a restart remembers the learned cap");
      // an expired cap is dropped too — an org that RAISES its cap is picked up
      fs.writeFileSync(file, JSON.stringify({ version: 2, rejected: {}, caps: { "claude-sonnet-5-5": ["medium", Date.now() - 8 * 24 * 3600 * 1000] } }));
      initEffortPersistence(file);
      assert(effortCap("claude-sonnet-5-5") === null, "caps expire after a week");
      fs.writeFileSync(file, JSON.stringify({ version: 1, rejected: {} }));
      initEffortPersistence(file);
      assert(effortCap("claude-sonnet-5-5") === null, "a version-1 file without caps loads fine");
      resetEffortRejections();
    }

    // the provider injects effort into the /v1/messages body, model-aware —
    // inside output_config (the wire shape CC 2.1.300 uses), never top-level
    const mkBody = (model: string): Record<string, unknown> => ({ model, max_tokens: 32, messages: [] });
    const withEffort = mkBody("claude-sonnet-5-5");
    assert(applyEffortToBody(withEffort, "high") === "high" && withEffort.output_config?.effort === "high", "body carries output_config.effort");
    assert(!("effort" in withEffort), "effort never rides as a top-level field");
    const merged = mkBody("claude-sonnet-5-5");
    merged.output_config = { format: { type: "json_schema" } };
    applyEffortToBody(merged, "xhigh");
    assert(merged.output_config.effort === "xhigh" && merged.output_config.format, "existing output_config keys survive the merge");
    const offBody = mkBody("claude-sonnet-5-5");
    assert(applyEffortToBody(offBody, "off") === null && !offBody.output_config, "off leaves the body untouched");
    const oldBody = mkBody("claude-3-opus-20240229");
    assert(applyEffortToBody(oldBody, "high") === null && !oldBody.output_config, "old models get no effort field");
    const midBody = mkBody("claude-haiku-5-5");
    assert(applyEffortToBody(midBody, "medium") === "medium" && midBody.output_config.effort === "medium", "effort level forwarded verbatim");
  }

  // ================================================== tool schema flattening
  {
    // clean schemas pass through untouched
    const clean = toApiInputSchema({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    assert(
      clean.type === "object" && (clean.properties as { a?: unknown }).a !== undefined && (clean.required as string[])[0] === "a",
      "clean schema passes through",
    );

    // allOf merges: union of properties and of required
    const all = toApiInputSchema({
      type: "object",
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    assert(
      !("allOf" in all) && (all.properties as Record<string, unknown>).a !== undefined && (all.properties as Record<string, unknown>).b !== undefined &&
        [...(all.required as string[])].sort().join(",") === "a,b",
      "allOf merges into a strict union",
    );

    // anyOf merges permissively: required survives only if every branch demands it
    const any = toApiInputSchema({
      anyOf: [
        { type: "object", properties: { mode: { type: "string" } }, required: ["mode"] },
        { type: "object", properties: { path: { type: "string" } } },
      ],
    });
    assert(
      any.type === "object" && !("anyOf" in any) && (any.properties as Record<string, unknown>).mode !== undefined &&
        (any.properties as Record<string, unknown>).path !== undefined && !("required" in any),
      "anyOf merges into a permissive union (required dropped)",
    );

    // oneOf keeps the field every branch requires
    const one = toApiInputSchema({
      type: "object",
      oneOf: [
        { properties: { a: { type: "string" }, extra: { type: "string" } }, required: ["a", "extra"] },
        { properties: { b: { type: "number" } }, required: ["a"] },
      ],
    });
    assert(
      !("oneOf" in one) && (one.required as string[]).join(",") === "a" && (one.properties as Record<string, unknown>).b !== undefined,
      "oneOf keeps only the common required field",
    );

    // F1002: the required-field intersection must be order-independent — a
    // branch with NO required array at all demands nothing, so it must
    // empty the intersection regardless of whether it is the first, middle
    // or last branch in the array.
    const noReqFirst = toApiInputSchema({
      oneOf: [
        { type: "object", properties: { a: { type: "string" } } }, // no required at all
        { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      ],
    });
    assert(!("required" in noReqFirst), `F1002: a no-required branch FIRST still empties the intersection (got ${JSON.stringify((noReqFirst as any).required)})`);
    const noReqMiddle = toApiInputSchema({
      oneOf: [
        { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
        { type: "object", properties: { a: { type: "string" } } }, // no required at all
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      ],
    });
    assert(!("required" in noReqMiddle), "F1002: array order does not matter — a no-required branch in the middle also empties the intersection");

    // a bare non-object schema cannot describe a tool input: empty object fallback
    const bare = toApiInputSchema({ type: "string", description: "just text" });
    assert(bare.type === "object" && Object.keys(bare.properties as object).length === 0 && bare.description === "just text", "non-object schema falls back to an empty object, description kept");

    // nested compositional keywords are the API's business — left untouched
    const nested = toApiInputSchema({ type: "object", properties: { x: { anyOf: [{ type: "string" }, { type: "number" }] } } });
    assert(((nested.properties as { x: { anyOf: unknown[] } }).x.anyOf as unknown[]).length === 2, "nested anyOf is left alone");

    // garbage never throws
    assert(toApiInputSchema(null).type === "object" && toApiInputSchema("nope").type === "object" && toApiInputSchema({}).type === "object", "garbage input never throws");
  }

  // =================================================== liveview (serve console)
  {
    const lines: string[] = [];
    let push: ((ev: Record<string, unknown>) => void) | null = null;
    const events = {
      subscribe: (fn: (ev: never) => void): (() => void) => {
        push = fn as typeof push;
        return () => {
          push = null;
        };
      },
    };
    const taps = new Set<(e: Record<string, unknown>) => void>();
    const stop = startLiveView({ events, httpTaps: taps as never }, { force: true, write: (l) => lines.push(l) });

    const ev = (type: string, data: Record<string, unknown>): void =>
      push?.({ type, ts: new Date().toISOString(), task_id: "tsk_test1", session_id: "ses_1", seq: 1, data });
    for (const t of taps) t({ type: "http.request", ts: new Date().toISOString(), method: "GET", path: "/v1/tasks", status: 200, duration_ms: 3 });
    ev("task.started", { model: "claude-sonnet-5-5", effort: "high", workdir: "D:/w" });
    ev("step.request", { step: 1, model: "claude-sonnet-5-5", messages: 3, tools: 24, max_tokens: 32000, effort: "high" });
    ev("tool.started", { name: "ls", input: { path: "." } });
    ev("task.heartbeat", { elapsed_ms: 1000 });
    stop();
    // after stop nothing is written anymore
    for (const t of taps) t({ type: "http.request", ts: new Date().toISOString(), method: "GET", path: "/v1/info", status: 200, duration_ms: 1 });

    const all = lines.join("\n");
    assert(all.includes("GET") && all.includes("/v1/tasks") && all.includes("200"), "liveview: http line");
    assert(all.includes("task.started") && all.includes("claude-sonnet-5-5"), "liveview: task.started line");
    assert(all.includes("step.request") && all.includes("msgs 3") && all.includes("effort high"), "liveview: step.request line");
    assert(all.includes("ls") && all.includes("path"), "liveview: tool line");
    assert(!all.includes("heartbeat"), "liveview: heartbeats are skipped");
    assert(!all.includes("/v1/info"), "liveview: stop() unsubscribes");
    assert(lines.filter(Boolean).length === 4, "liveview: one compact line per event");
  }

  console.log("UNIT CORE TESTS PASSED ✓ (compaction, cache, effort, messages, tool, config, paths, banner, prompt, usage, maintenance)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
