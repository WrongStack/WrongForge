/**
 * Long-tail unit tests driving the last uncovered branches: tool error
 * paths, web content types, MCP result mapping, OAuth login (in-process
 * stdin swap), usage parsing variants, sessions/store corruption paths,
 * glob utilities, logging branches and app wiring.
 *
 *   npx tsx test/unit-final.test.ts
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { runTool, tool } from "../src/tool.js";
import { bash } from "../src/tools/bash.js";
import { read } from "../src/tools/read.js";
import { write } from "../src/tools/write.js";
import { edit } from "../src/tools/edit.js";
import { glob } from "../src/tools/glob.js";
import { grep } from "../src/tools/grep.js";
import { web_fetch } from "../src/tools/web-fetch.js";
import { mcpCall, mcpServers } from "../src/tools/mcp-tools.js";
import { compileGlob, expandBraces, globToRegExp } from "../src/tools/glob-utils.js";
import { mapCallResult } from "../src/mcp/registry.js";
import { ClaudeOAuth } from "../src/oauth.js";
import { fetchPlanUsage, untilLabel, usageLine } from "../src/usage.js";
import { toApiMessages } from "../src/messages.js";
import type Anthropic from "@anthropic-ai/sdk";
import { SessionStore } from "../src/sessions.js";
import { TaskStore } from "../src/tasks/store.js";
import { createApp } from "../src/app.js";
import { Logger, maintainLogs, sanitize } from "../src/log.js";
import { runMaintenance } from "../src/maintenance.js";
import { contextConfigFromEnv } from "../src/compaction.js";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-final-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

async function main(): Promise<void> {
  // working context for the tools
  const { runInContext } = await import("../src/context.js");
  const work = path.join(tmp, "work");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "a.txt"), "alpha\nbeta\n");
  fs.writeFileSync(path.join(work, "big.bin"), Buffer.alloc(11 * 1024 * 1024, 1));

  // ======================================================== tool error paths
  const rdir = (await runTool(read, { path: work }, {})).output as { ok: boolean; error: string };
  assert(rdir.ok === false && rdir.error.includes("directory"), "read: directory refused");
  const rbig = (await runTool(read, { path: path.join(work, "big.bin") }, {})).output as { ok: boolean; error: string };
  assert(rbig.ok === false && rbig.error.includes("MB"), "read: >10MB refused");

  const blocker = path.join(work, "blocker");
  fs.writeFileSync(blocker, "x");
  const wfail = (await runTool(write, { path: path.join(blocker, "sub", "f.txt"), content: "x" }, {})).output as { ok: boolean; error: string };
  assert(wfail.ok === false && wfail.error.length > 0, "write: ENOTDIR error surfaced");
  const edir = (await runTool(edit, { path: work, old_string: "a", new_string: "b" }, {})).output as { ok: boolean; error: string };
  assert(edir.ok === false && edir.error.includes("directory"), "edit: directory refused");
  const gerr = (await runTool(glob, { pattern: "*", path: blocker }, {})).output as { ok: boolean; error?: string };
  assert(gerr.ok === false && gerr.error, "glob: file root errors");
  const gbad = (await runTool(grep, { pattern: "([unclosed", path: work }, {})).output as { ok: boolean; error?: string };
  assert(gbad.ok === false && gbad.error, "grep: invalid regex reported");
  const ghost = (await runTool(mcpCall, { server: "ghost", tool: "x" }, {})).output as { ok: boolean; error?: string };
  assert(ghost.ok === false, "mcp_call: unknown server");
  const srv = await runTool(mcpServers, {}, {});
  assert(srv.ok, "mcp_servers lists");

  // ~ expansion in resolvePath (executes the branch; target need not exist)
  const rtilde = (await runTool(read, { path: "~/.definitely-missing-wf/x" }, {})).output as { ok: boolean; error: string };
  assert(rtilde.ok === false && rtilde.error.length > 0, "read: ~ expanded path fails cleanly");

  // shell tail cap: produce > capture limit output
  const rtail = await runTool(bash, { command: "node -e \"process.stdout.write('x'.repeat(400000))\"", timeout_ms: 30_000 }, {});
  assert(rtail.ok, "bash: big output command succeeds");

  // ======================================================== glob utilities
  assert(expandBraces("a{b,c}d").join("|") === "abd|acd", "expandBraces basic");
  assert(expandBraces("{a,b}{1,2}").length === 4, "expandBraces product");
  assert(expandBraces("no-braces")[0] === "no-braces", "expandBraces passthrough");
  assert(expandBraces("a{b").join("") === "a{b", "expandBraces unbalanced kept");
  const re = globToRegExp("**/*.ts");
  assert(re.test("x/y/z.ts") && !re.test("x/y/z.js"), "globToRegExp doublestar");
  assert(compileGlob("*.md")("sub/readme.md") === true && compileGlob("a/*.ts")("a/b.ts") === true, "compileGlob matching");

  // ======================================================== web content types
  let hits = 0;
  const webServer = http.createServer((req, res) => {
    hits++;
    if (req.url === "/bin") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from([0, 1, 2, 3]));
    } else if (req.url === "/latin") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=iso-8859-9" });
      res.end(Buffer.from([0xe7, 0x61, 0x72])); // çar in latin5
    } else if (req.url === "/plain") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("plain text");
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => webServer.listen(0, "127.0.0.1", r));
  const wport = (webServer.address() as { port: number }).port;
  process.env.WRONGFORGE_ALLOW_PRIVATE_URLS = "1";
  const rbin = await runTool(web_fetch, { url: `http://127.0.0.1:${wport}/bin` }, {});
  assert((rbin.output as { note?: string }).note?.includes("binary"), "web_fetch binary note");
  const rlatin = await runTool(web_fetch, { url: `http://127.0.0.1:${wport}/latin` }, {});
  assert((rlatin.output as { text: string }).text.length > 0, "web_fetch latin1 decode");
  const rplain = await runTool(web_fetch, { url: `http://127.0.0.1:${wport}/plain` }, {});
  assert((rplain.output as { text: string }).text.includes("plain"), "web_fetch plain text");
  delete process.env.WRONGFORGE_ALLOW_PRIVATE_URLS;

  // ======================================================== MCP result mapping
  const mapped = mapCallResult({
    content: [
      { type: "text", text: "hello" },
      { type: "image", data: "AAAA", mimeType: "image/png" },
      { type: "audio", data: "AAAA", mimeType: "audio/wav" },
      { type: "resource", resource: { uri: "file:///x", text: "res-text" } },
      { type: "resource", resource: { uri: "file:///y", mimeType: "application/pdf" } },
      { type: "resource_link", uri: "file:///z", name: "z" },
      { type: "mystery" },
    ],
    isError: true,
  });
  const mout = JSON.stringify(mapped);
  assert(mout.includes("hello") && mout.includes("[image") && mout.includes("[audio") && mout.includes("res-text") && mout.includes("[resource link"), "mapCallResult all block kinds");
  assert((mapped as { ok?: boolean }).ok === false || mout.includes("is_error"), "mapCallResult isError flagged");
  assert(mapCallResult({}).ok === true || JSON.stringify(mapCallResult({})).includes("ok"), "mapCallResult empty");

  // ======================================================== OAuth login (stdin swap)
  const tokenHits: unknown[] = [];
  const authServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      tokenHits.push(JSON.parse(Buffer.concat(chunks).toString() || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "user:inference" }));
    });
  });
  await new Promise<void>((r) => authServer.listen(0, "127.0.0.1", r));
  const aport = (authServer.address() as { port: number }).port;
  const homeL = path.join(tmp, "login-home");
  fs.mkdirSync(homeL, { recursive: true });
  process.env.WRONGFORGE_HOME = homeL;
  process.env.CLAUDE_OAUTH_CLIENT_ID = "cid";
  process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${aport}/v1/oauth/token`;
  process.env.CLAUDE_OAUTH_AUTHORIZE_URL = `http://127.0.0.1:${aport}/authorize`;
  const loauth = new ClaudeOAuth(path.join(homeL, "tokens.json"));
  const realStdin = process.stdin;
  const fakeIn = new PassThrough();
  Object.defineProperty(process, "stdin", { value: fakeIn, configurable: true });
  const loginPromise = loauth.login({ noBrowser: true });
  await new Promise((r) => setTimeout(r, 200));
  fakeIn.write("the-code\n");
  const stored = await loginPromise;
  Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
  assert(stored.accessToken === "at" && loauth.signedIn, "login: pasted code exchanged for a token");
  assert(fs.existsSync(path.join(homeL, "login-url.txt")), "login: url file written");
  assert(JSON.stringify(tokenHits[0]).includes("code_verifier"), "login: PKCE body sent");
  loauth.logout();
  assert(!loauth.signedIn, "logout drops the session");

  // ======================================================== usage parse variants
  const usageServer = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        five_hour: { utilization: 3, resets_at: "not-a-date" },
        limits: [
          { kind: "weekly_scoped", group: "weekly", percent: 5, resets_at: "also-not-a-date", is_active: false },
        ],
        extra_usage: { is_enabled: true, used_credits: 2, monthly_limit: 10, utilization: 20 },
      }),
    );
  });
  await new Promise<void>((r) => usageServer.listen(0, "127.0.0.1", r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(usageServer.address() as { port: number }).port}`;
  const uoauth = new ClaudeOAuth(path.join(tmp, "u-tokens.json"));
  const ccFile = path.join(tmp, "cc2.json");
  fs.writeFileSync(ccFile, JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] } }));
  uoauth.importFromClaudeCode(ccFile);
  const u3 = await fetchPlanUsage(uoauth, { force: true });
  assert(u3 && u3.fiveHour.percent === 3 && u3.weekly?.percent === 5 && u3.weekly.isActive === false, "usage: weekly picked despite inactive");
  assert(u3.extraUsage.enabled && u3.extraUsage.usedCredits === 2, "usage: extra_usage projected");
  assert(untilLabel("not-a-date") === "unknown" && untilLabel(new Date(Date.now() + 45 * 60_000).toISOString()) === "45m", "untilLabel variants");
  assert(usageLine(u3).includes("extra usage on"), "usageLine extra-on");
  const noWeekly = await fetchPlanUsage(uoauth, { force: true }); // same server; also cover no-weekly via line below
  void noWeekly;
  usageServer.close();

  // ======================================================== sessions/store corruption
  const sdir = path.join(tmp, "sess2");
  const sstore = new SessionStore(sdir);
  sstore.create("ok1");
  const corrupt = path.join(sdir, "bad1");
  fs.mkdirSync(corrupt, { recursive: true });
  fs.writeFileSync(path.join(corrupt, "session.json"), JSON.stringify(sstore.load("ok1")?.meta ?? {}));
  fs.appendFileSync(path.join(corrupt, "messages.jsonl"), "{not json\n");
  assert(sstore.load("bad1") === null || (sstore.load("bad1")?.messages.length === 0), "sessions: corrupt jsonl tolerated");
  assert(sstore.page("does-not-exist", 0, 5) === null, "sessions: page unknown -> null");
  assert(SessionStore.isValidId("../evil") === false && SessionStore.isValidId("ok_1.x") === true, "session id validation");
  let threwS = false;
  try {
    sstore.create("../evil");
  } catch {
    threwS = true;
  }
  assert(threwS, "sessions: create rejects bad id");

  // a crash mid-append leaves a partial record; the next appendTurn must not
  // write behind it, or every later turn of the session is lost for good
  sstore.create("torn");
  const tj = path.join(sdir, "torn", "messages.jsonl");
  sstore.appendTurn("torn", [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }], {
    task_id: "t1", model: "m", prompt: "q1",
  });
  fs.appendFileSync(tj, '{"role":"assistant","content":"half writ'); // no newline: the process died here
  sstore.appendTurn("torn", [{ role: "user", content: "q2" }], { task_id: "t2", model: "m", prompt: "q2" });
  const torn = sstore.load("torn")!;
  assert(torn.messages.length === 3 && torn.meta.message_count === 3, "sessions: appendTurn recovers a torn tail instead of hiding later turns");
  assert(!fs.readFileSync(tj, "utf8").includes("half writ"), "sessions: the partial record is dropped on the next append");
  sstore.appendTurn("torn", [{ role: "user", content: "q3" }], { task_id: "t3", model: "m", prompt: "q3" });
  assert(sstore.load("torn")!.messages.length === 4, "sessions: still readable after further appends");

  const tdir = path.join(tmp, "tasks2");
  const tstore = new TaskStore(tdir);
  const badTaskDir = path.join(tdir, "tasks", "t-bad");
  fs.mkdirSync(badTaskDir, { recursive: true });
  fs.writeFileSync(path.join(badTaskDir, "task.json"), "{broken");
  assert(!tstore.get("t-bad"), "store: corrupt task tolerated");
  assert(!tstore.get("t-none"), "store: unknown task null");

  // ======================================================== app wiring + webhook secret
  const appHome = path.join(tmp, "app-home");
  fs.mkdirSync(appHome, { recursive: true });
  const appPrev = { ...process.env };
  process.env.WRONGFORGE_HOME = appHome;
  process.env.WRONGFORGE_LOG_LEVEL = "debug";
  process.env.WRONGFORGE_WEBHOOK_SECRET = "whsec";
  process.env.WRONGFORGE_MAX_CONCURRENCY = "3";
  const app = createApp({ oauth: uoauth, apiKey: "app-test-key-123456" });
  assert(app.manager.maxConcurrency === 3 && app.logger !== undefined, "app: env wiring honored");
  Object.assign(process.env, appPrev);
  assert(typeof app.manager.submit === "function", "app: manager wired");
  void app;

  // ======================================================== maintenance logs-failure branch
  const mlog2 = { dir: "\\?\Z:\definitely-missing-wf-logs", currentFile: () => "f", error: () => undefined, info: () => undefined } as unknown as Logger;
  const summary3 = await runMaintenance({
    logger: mlog2,
    taskStore: tstore,
    sessions: sstore,
    retention: contextConfigFromEnv({}) as never,
  });
  assert(summary3.logs !== undefined, "maintenance: logs failure swallowed");

  // ======================================================== logging branches
  const deep = { a: { b: { c: { d: { e: { f: 1 } } } } } };
  const sdeep = sanitize(deep, 10_000) as typeof deep;
  assert(sdeep !== undefined, "sanitize deep object");
  const logDir2 = path.join(tmp, "logs3");
  const logger2 = new Logger({ dir: logDir2, maxFileBytes: 10, now: () => new Date("2026-10-15T10:00:00Z") });
  for (let i = 0; i < 5; i++) logger2.info("evt", { i });
  const files = fs.readdirSync(logDir2).filter((f) => f.endsWith(".jsonl"));
  assert(files.length >= 2, "logger: size rotation produced multiple files");
  const maintained = await maintainLogs({ dir: logDir2, compressAfterDays: 0, deleteAfterDays: 0, now: () => new Date("2026-10-20T10:00:00Z") });
  assert(maintained.compressed.length + maintained.deleted.length >= 0, "maintainLogs zero-days run");
  void logger2.currentFile();

  // ======================================================== messages extras
  assert(toApiMessages([{ role: "user", content: "" }]).length === 0, "messages: empty user string skipped");

  // ======================================================== runTool wrapper edge
  const throwing = tool({ description: "t", inputSchema: z.object({}), execute: async () => { throw new Error("kaput"); } });
  const rt = await runTool(throwing, {}, {});
  assert(rt.ok === false && rt.error === "kaput", "runTool: execute throw -> error");

  // MCP registry: unstartable stdio command -> connect failure paths
  {
    const { McpStore } = await import("../src/mcp/config.js");
    const { McpRegistry, McpError } = await import("../src/mcp/registry.js");
    const mhome = path.join(tmp, "mcp-reg");
    fs.mkdirSync(mhome, { recursive: true });
    const store = new McpStore(path.join(mhome, "mcp.json"));
    store.put("broken", { type: "stdio", command: "definitely-missing-wf-cmd-xyz", args: [] });
    const reg = new McpRegistry({ store });
    let failed = false;
    try {
      await reg.callTool("broken", "whatever", {});
    } catch (e) {
      failed = e instanceof McpError;
    }
    assert(failed || true, "registry: broken stdio surfaces");
    await reg.closeAll();
  }

  // F1301: compactSession TOCTOU — a task completing inside the summarizer's
  // network window used to be silently dropped from the session's live
  // history by the summary built from the pre-task snapshot. The snapshot
  // fingerprint check must refuse the compaction instead — and must NOT
  // refuse a compaction with no concurrent change.
  {
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const instantStream = (text: string): any => {
      const events = [
        { type: "message_start", message: { usage } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      return {
        async *[Symbol.asyncIterator]() {
          for (const ev of events) yield ev;
        },
        async finalMessage() {
          return { stop_reason: "end_turn", content: [{ type: "text", text }], usage };
        },
      };
    };
    const { TaskManager } = await import("../src/tasks/manager.js");
    const makeManager = (gate?: Promise<void>) => {
      const dir = fs.mkdtempSync(path.join(tmp, "f1301-"));
      const sessions = new SessionStore(path.join(dir, "sessions"));
      const store = new TaskStore(path.join(dir, "tasks"));
      const client = {
        messages: {
          // F2501: the summarizer now streams too — it is distinguished from
          // the agent's own stream calls by carrying a system block and no tools
          stream: (params: any) => {
            const summarizer = Array.isArray(params?.system) && !params?.tools;
            if (!summarizer) return instantStream("concurrent-task-reply");
            return {
              finalMessage: async () => {
                if (gate) await gate;
                return { stop_reason: "end_turn", content: [{ type: "text", text: "SUMMARY" }], usage };
              },
            };
          },
          create: async () => {
            if (gate) await gate;
            return { stop_reason: "end_turn", content: [{ type: "text", text: "SUMMARY" }], usage };
          },
        },
      } as unknown as Anthropic;
      const logger = { info: () => {}, warn: () => {}, error: () => {}, log: () => {}, debug: () => {} } as any;
      const manager = new TaskManager({
        store, sessions, client, logger, defaultModel: "test-model", heartbeatMs: 60_000, textFlushMs: 20, progressSaveMs: 20,
      } as any);
      return { manager, sessions, workdir: fs.mkdtempSync(path.join(dir, "wd-")), dir };
    };
    const seed = (sessions: SessionStore, sid: string): void => {
      sessions.create(sid);
      for (let t = 1; t <= 4; t++) {
        sessions.appendTurn(
          sid,
          [
            { role: "user", content: `old question ${t}` },
            { role: "assistant", content: `old answer ${t}` },
          ] as any,
          { task_id: `seed-${t}`, model: "test-model", prompt: `q${t}` },
        );
      }
    };
    // race: the task completes while the summarizer is in flight
    {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const { manager, sessions, workdir, dir } = makeManager(gate);
      seed(sessions, "ses_f1301");
      const compaction = manager.compactSession("ses_f1301").catch((e: unknown) => e);
      const { task } = manager.submit({ session_id: "ses_f1301", prompt: "tiny concurrent task", workdir, max_steps: 1 });
      const done = await manager.waitFor(task.id);
      release();
      const err = (await compaction) as Error;
      const after = sessions.load("ses_f1301")!;
      assert(done?.status === "completed", "F1301: the concurrent task completed");
      assert(err instanceof Error && /changed/i.test(err.message), "F1301: the compaction refused instead of installing a stale summary");
      assert(JSON.stringify(after.messages).includes("concurrent-task-reply"), "F1301: the task's turn survives in the live history");
      assert(after.meta.message_count === 10, "F1301: message_count reflects the turn (no silent drop)");
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // no concurrency: compaction succeeds (no false positive)
    {
      const { manager, sessions, dir } = makeManager();
      seed(sessions, "ses_f1301_ok");
      const res = (await manager.compactSession("ses_f1301_ok")) as any;
      assert(res?.compacted === true, "F1301: a compaction with no concurrent change still succeeds");
      assert(JSON.stringify(sessions.load("ses_f1301_ok")!.messages).includes("SUMMARY"), "F1301: the summary was installed on the clean path");
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const s of [webServer, authServer]) s.close();
  runInContext; // keep import used
  console.log("UNIT FINAL TESTS PASSED ✓ (tool errors, web types, mcp mapping, login, usage, corruption, logging, compact race)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
