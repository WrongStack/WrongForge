/**
 * CLI entry tests: the REPL (main.ts), the HTTP server entry (server.ts
 * isMain block), mcp-cli subcommands and init-config — every child runs
 * offline against local mock servers with its own WRONGFORGE_HOME.
 *
 *   npx tsx test/cli.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { ClaudeOAuth } from "../src/oauth.js";

const assert = (cond: boolean, label: string): void => {
  if (!cond) throw new Error(`assertion failed: ${label}`);
};

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wrongforge-cli-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// Direct node + tsx cli (no shell): the spawned pid IS the test process, so
// kill() actually works and coverage flushes on clean exits.
const TSX = process.execPath;
const TSX_ARGS = [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")];

interface RunResult {
  code: number | null;
  out: string;
  err: string;
}

function run(file: string, args: string[], opts: { env?: Record<string, string>; input?: string; cwd?: string; timeoutMs?: number; keepStdin?: boolean; laterInput?: { afterMs: number; text: string } } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stripped = { ...process.env };
    for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_TOKEN_URL", "CLAUDE_OAUTH_CLIENT_ID", "ANTHROPIC_API_KEY"]) delete stripped[k];
    const env: NodeJS.ProcessEnv = {
      ...stripped,
      NO_COLOR: "1",
      WRONGFORGE_HOME: path.join(tmp, `home-${Math.random().toString(36).slice(2, 8)}`),
      ...opts.env,
    };
    const child: ChildProcess = spawn(TSX, [...TSX_ARGS, file, ...args], {
      env,
      cwd: opts.cwd ?? ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    const killer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill();
      }
    }, opts.timeoutMs ?? 30_000);
    if (opts.input !== undefined) {
      child.stdin?.write(opts.input);
    }
    if (opts.laterInput) {
      // write more input after a delay, then close stdin so the child exits
      // cleanly (a clean exit is what flushes its V8 coverage)
      const { afterMs, text } = opts.laterInput;
      setTimeout(() => {
        child.stdin?.write(text);
        child.stdin?.end();
      }, afterMs).unref();
    } else if (!opts.keepStdin) child.stdin?.end();
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out, err });
    });
  });
}

/** Minimal mock: /v1/oauth/token + /v1/messages (SSE "OK") + /api/oauth/usage. */
function mockAnthropic(): Promise<{ port: number; close: () => void; bodies: any[] }> {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      if (req.url === "/v1/oauth/token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "user:inference" }));
        return;
      }
      if (req.url === "/api/oauth/usage") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
            limits: [{ kind: "session", group: "session", percent: 10, resets_at: new Date(Date.now() + 3_600_000).toISOString(), is_active: true }],
            extra_usage: { is_enabled: false },
          }),
        );
        return;
      }
      if (req.url?.startsWith("/v1/messages")) {
        bodies.push(body);
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}\ndata: ${JSON.stringify(o)}\n\n`);
        w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 9, output_tokens: 1 } } });
        w({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        w({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } });
        w({ type: "content_block_stop", index: 0 });
        w({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
        w({ type: "message_stop" });
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ port: (server.address() as { port: number }).port, close: () => server.close(), bodies })));
}

/** Kills a shell-spawned child AND its process tree (Windows-safe). */
function killTree(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}

/** Picks a currently-free TCP port (bind + close). */
function freePort(): Promise<number> {
  return new Promise((r) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => r(p));
    });
  });
}

async function main(): Promise<void> {
  // ======================================================== init-config
  const cfgHome = path.join(tmp, "cfg-home");
  const r1 = await run("src/init-config.ts", [], { env: { WRONGFORGE_HOME: cfgHome } });
  assert(r1.code === 0 && fs.existsSync(path.join(cfgHome, "oauth.json")), "init-config writes oauth.json");
  const r2 = await run("src/init-config.ts", [], { env: { WRONGFORGE_HOME: cfgHome } });
  assert(r2.out.includes("already exists"), "init-config idempotent message");

  // paths: legacy migration (homedir with .wrongminiagent, no .wrongforge)
  const fakeHome = path.join(tmp, "fake-home");
  const legacy = path.join(fakeHome, ".wrongminiagent");
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "legacy-marker.txt"), "x");
  const env3: Record<string, string> = { USERPROFILE: fakeHome, HOME: fakeHome, HOMEPATH: "", HOMEDRIVE: "", WRONGFORGE_HOME: "" };
  const r3 = await run("src/init-config.ts", [], { env: env3 });
  assert(r3.code === 0 && fs.existsSync(path.join(fakeHome, ".wrongforge", "oauth.json")), "legacy .wrongminiagent migrated to .wrongforge");
  assert(fs.existsSync(path.join(legacy, "legacy-marker.txt")), "legacy dir left in place");

  // ======================================================== server entry
  const mock = await mockAnthropic();
  const srvHome = path.join(tmp, "srv-home");
  const srvEnv: Record<string, string> = {
    WRONGFORGE_HOME: srvHome,
    AGENT_API_KEY: "cli-test-key-1234567890",
    PORT: String(await freePort()),
    HOST: "127.0.0.1",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
    ANTHROPIC_TOKEN_URL: `http://127.0.0.1:${mock.port}/v1/oauth/token`,
    CLAUDE_OAUTH_CLIENT_ID: "cli-test",
  };
  // seed a token into the child's home first (exchange against the mock)
  {
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = srvHome;
    process.env.ANTHROPIC_TOKEN_URL = srvEnv.ANTHROPIC_TOKEN_URL;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "cli-test";
    const oauth = new ClaudeOAuth(path.join(srvHome, "tokens.json"));
    const cc = path.join(tmp, "cc.json");
    fs.writeFileSync(cc, JSON.stringify({ claudeAiOauth: { accessToken: "s", refreshToken: "r", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));
    oauth.importFromClaudeCode(cc);
    Object.assign(process.env, prev);
  }
  // Real server entry, exercised in a CHILD process (clean exit → coverage
  // flushes; isolation keeps this suite's later spawns untouched).
  const entry = await run("test/helpers/entry-runner.ts", [], {
    env: { ...srvEnv, WF_ENTRY_WORKDIR: tmp, WRONGFORGE_MAX_BODY_BYTES: "300000", WF_EXPECTED_BODY_CAP: "300000" },
    timeoutMs: 90_000,
  });
  if (!(entry.code === 0 && entry.out.includes("ENTRY-OK"))) { console.error("ENTRYFULL", entry.out.slice(-1500), "ERR:", entry.err.slice(-500)); }
  assert(entry.code === 0 && entry.out.includes("ENTRY-OK"), `server entry child failed (code ${entry.code})`);

  // EADDRINUSE: two servers on one fixed port
  const fixed = await freePort();
  const s1 = spawn(TSX, [...TSX_ARGS, "src/server.ts"], {
    env: { ...process.env, ...srvEnv, PORT: String(fixed), AGENT_API_KEY: "long-enough-key-1" },
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  });
  let s1up = false;
  let srvOut2 = "";
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, 40_000);
    s1.stdout.on("data", (d: Buffer) => (srvOut2 += d.toString()));
    s1.stdout.on("data", (d: Buffer) => {
      if (d.toString().includes(String(fixed))) {
        s1up = true;
        clearTimeout(t);
        resolve();
      }
    });
    s1.on("close", () => { clearTimeout(t); resolve(); });
  });
  if (!s1up) console.error("S1OUT:", srvOut2.slice(0, 600));
  assert(s1up, "first fixed-port server up");
  const r_dup = await run("src/server.ts", [], { env: { ...srvEnv, PORT: String(fixed) }, timeoutMs: 40_000 });
  assert(r_dup.code === 1 && (r_dup.out + r_dup.err).includes("already in use"), "EADDRINUSE exits with message");
  killTree(s1);

  // too-short AGENT_API_KEY is refused with a clear message
  const r_short = await run("src/server.ts", [], { env: { ...srvEnv, AGENT_API_KEY: "k1" }, timeoutMs: 40_000 });
  assert(r_short.code === 1, "short AGENT_API_KEY exits 1");

  // ======================================================== REPL (main.ts)
  const replHome = path.join(tmp, "repl-home");
  {
    const prev = { ...process.env };
    process.env.WRONGFORGE_HOME = replHome;
    process.env.ANTHROPIC_TOKEN_URL = srvEnv.ANTHROPIC_TOKEN_URL;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "cli-test";
    const oauth = new ClaudeOAuth(path.join(replHome, "tokens.json"));
    oauth.importFromClaudeCode(path.join(tmp, "cc.json"));
    Object.assign(process.env, prev);
  }
  const replEnv: Record<string, string> = {
    WRONGFORGE_HOME: replHome,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.port}`,
    ANTHROPIC_TOKEN_URL: srvEnv.ANTHROPIC_TOKEN_URL,
    CLAUDE_OAUTH_CLIENT_ID: "cli-test",
  };
  // commands-only pass: piped lines never race an async turn
  const repl = await run("src/main.ts", [], {
    env: replEnv,
    input: ["/help", "/status", "/tools", "/model claude-haiku-5-5", "/reset", "/nope", "/usage", "/exit"].join("\n"),
    timeoutMs: 60_000,
  });
  assert(repl.out.includes("claude-haiku-5-5"), "repl: /model switches");
  assert(repl.out.includes("history cleared"), "repl: /reset");
  assert(repl.out.includes("unknown command"), "repl: unknown command");
  assert(repl.out.includes("5h session") || repl.out.includes("usage unavailable"), "repl: /usage either source");
  assert(repl.out.includes("signedIn"), "repl: /status");
  assert(repl.out.includes("bash") && repl.out.includes("read"), "repl: /tools lists");
  // one real turn; stdin stays open, the timeout tree-kills the process
  const turnRun = await run("src/main.ts", [], {
    env: replEnv,
    input: "say exactly OK\n",
    keepStdin: true,
    timeoutMs: 15_000,
  });
  assert(turnRun.out.includes("OK"), "repl: turn output");
  assert(turnRun.out.includes("end_turn"), "repl: usage footer");

  // unknown-tool turn: the model calls a nonexistent tool -> tool-error print path
  const toolMock = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const w = (o: unknown) => res.write(`event: ${String((o as { type: string }).type)}
data: ${JSON.stringify(o)}

`);
    w({ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 4, output_tokens: 1 } } });
    w({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu9", name: "no_such_tool", input: {} } });
    w({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
    w({ type: "content_block_stop", index: 0 });
    w({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } });
    w({ type: "message_stop" });
    res.end();
  });
  await new Promise<void>((r) => toolMock.listen(0, "127.0.0.1", r));
  const toolPort = (toolMock.address() as { port: number }).port;
  const toolRun = await run("src/main.ts", [], {
    env: { ...replEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${toolPort}` },
    input: "call the tool\n",
    laterInput: { afterMs: 10_000, text: "/exit\n" },
    timeoutMs: 40_000,
  });
  const toolAll = toolRun.out + toolRun.err;
  assert(toolAll.includes("no_such_tool") && toolAll.includes("tool error"), "repl: unknown tool error printed");
  toolMock.close();

  // failing turn: the mock answers 500 -> the error branch prints and the turn is rolled back
  const failMock = http.createServer((req, res) => {
    if (req.url === "/v1/oauth/token") {
      res.writeHead(200).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "s" }));
      return;
    }
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
  });
  await new Promise<void>((r) => failMock.listen(0, "127.0.0.1", r));
  const failPort = (failMock.address() as { port: number }).port;
  const errRun = await run("src/main.ts", ["chat"], {
    env: { ...replEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${failPort}` },
    input: "trigger the error\n",
    laterInput: { afterMs: 12_000, text: "/exit\n" },
    timeoutMs: 40_000,
  });
  const errAll = errRun.out + errRun.err;
  assert(errAll.includes("[error]"), "repl: error branch prints");
  failMock.close();

  // repl without a signed-in session: /models falls back to known list
  const emptyHome = path.join(tmp, "empty-home");
  const fastFailAuth = { ANTHROPIC_TOKEN_URL: "http://127.0.0.1:9/token", CLAUDE_OAUTH_CLIENT_ID: "x" };
  const r_models = await run("src/main.ts", [], {
    env: { WRONGFORGE_HOME: emptyHome, ...fastFailAuth },
    input: "/models\n/exit\n",
    timeoutMs: 60_000,
  });
  assert(r_models.out.includes("claude-sonnet-5-5"), "repl: /models known fallback");

  // repl: model from CLAUDE_MODEL env
  const r_envmodel = await run("src/main.ts", [], {
    env: { WRONGFORGE_HOME: emptyHome, CLAUDE_MODEL: "claude-opus-5-5", ...fastFailAuth },
    input: "/exit\n",
    timeoutMs: 60_000,
  });
  assert(r_envmodel.out.includes("claude-opus-5-5"), "repl: CLAUDE_MODEL env");

  // ======================================================== refresh
  // `wrongforge refresh`: a lightweight, serve-independent way to use the
  // refresh token — not signed in -> exit 1; signed in -> exercises the
  // real refresh() flow, followed by the same GET /v1/models `wrongforge
  // models` makes (so a lone refresh never leaves the shape CC's own
  // traffic produces — see the comment on the command in src/main.ts),
  // against a fake endpoint, and exits 0.
  {
    const refreshHome = path.join(tmp, "refresh-home");
    const noTokenRun = await run("src/main.ts", ["refresh"], { env: { WRONGFORGE_HOME: refreshHome } });
    assert(noTokenRun.code === 1 && noTokenRun.err.includes("not signed in"), "refresh without a session exits 1 with a clear message");

    let modelsRequests = 0;
    const tokenServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        if (req.url === "/v1/oauth/token") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ access_token: "refresh-cmd-at", refresh_token: "refresh-cmd-rt", expires_in: 3600, scope: "user:inference" }));
          return;
        }
        if (req.url?.startsWith("/v1/models")) {
          modelsRequests++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5" }], has_more: false }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => tokenServer.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}`;
    const tokenStore = path.join(tmp, "refresh-cmd-tokens.json");
    // pre-seed a signed-in session the same way `login`/`import` would
    const seedOauth = new ClaudeOAuth(tokenStore);
    process.env.ANTHROPIC_TOKEN_URL = `${base}/v1/oauth/token`;
    process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";
    await seedOauth.exchangeCode("seed-code", "seed-verifier", "https://console.anthropic.com/oauth/code/callback", "user:inference");
    delete process.env.ANTHROPIC_TOKEN_URL;
    delete process.env.CLAUDE_OAUTH_CLIENT_ID;

    const refreshRun = await run("src/main.ts", ["refresh"], {
      env: { CLAUDE_TOKEN_STORE: tokenStore, ANTHROPIC_TOKEN_URL: `${base}/v1/oauth/token`, ANTHROPIC_BASE_URL: base, CLAUDE_OAUTH_CLIENT_ID: "test-client-id" },
    });
    tokenServer.close();
    assert(refreshRun.code === 0 && /refreshed; access token valid until .* \(1 models reachable\)/.test(refreshRun.out), `refresh with a signed-in session exits 0 (${refreshRun.code}, ${refreshRun.out}${refreshRun.err})`);
    assert(modelsRequests === 1, "the refresh command makes exactly the one follow-up models request");
  }

  // ======================================================== mcp-cli
  // An actionable CLI failure stays concise; debug mode retains its stack.
  const missingCredentials = path.join(tmp, "missing-credentials.json");
  const errEnv = { CLAUDE_CREDENTIALS_FILE: missingCredentials, WRONGFORGE_DEBUG: "0" };
  const concise = await run("src/main.ts", ["import"], { env: errEnv });
  assert(concise.code === 1 && concise.err.includes("cannot read") && !/\n\s+at /.test(concise.err), "CLI failure prints the actionable message without a stack");
  for (const debug of ["1", "true"]) {
    const detailed = await run("src/main.ts", ["import"], { env: { ...errEnv, WRONGFORGE_DEBUG: debug } });
    assert(detailed.code === 1 && detailed.err.includes("cannot read") && /\n\s+at /.test(detailed.err), `WRONGFORGE_DEBUG=${debug} retains the error stack`);
  }

  const mcpHome = path.join(tmp, "mcp-home");
  const mEnv = { WRONGFORGE_HOME: mcpHome };
  const m_add = await run("src/mcp-cli.ts", ["add", "fs", "--command", "node", "--", "server.js"], { env: mEnv });
  assert(m_add.code === 0 && m_add.out.includes("fs"), "mcp add");
  const m_addurl = await run("src/mcp-cli.ts", ["add", "remote", "--url", "https://example.com/mcp"], { env: mEnv });
  assert(m_addurl.code === 0, "mcp add --url");
  const m_bad = await run("src/mcp-cli.ts", ["add", "broken"], { env: mEnv });
  assert(m_bad.code !== 0, "mcp add without command/url fails");
  const m_list = await run("src/mcp-cli.ts", ["list"], { env: mEnv });
  assert(m_list.out.includes("fs") && m_list.out.includes("remote"), "mcp list");
  const m_rm = await run("src/mcp-cli.ts", ["remove", "remote"], { env: mEnv });
  assert(m_rm.code === 0, "mcp remove");
  const m_path = await run("src/mcp-cli.ts", ["path"], { env: mEnv });
  assert(m_path.out.includes("mcp"), "mcp path");
  const m_help = await run("src/mcp-cli.ts", [], { env: mEnv });
  assert(m_help.out.includes("Usage"), "mcp usage/help");
  const m_unknown = await run("src/mcp-cli.ts", ["frobnicate"], { env: mEnv });
  assert(m_unknown.code !== 0, "mcp unknown command fails");
  const m_addjson = await run("src/mcp-cli.ts", ["add-json", "jj", '{"type":"http","url":"https://j.example"}'], { env: mEnv });
  assert(m_addjson.code === 0 && m_addjson.out.includes("jj"), "mcp add-json");
  const m_addjson_bad = await run("src/mcp-cli.ts", ["add-json", "jb", "{nope"], { env: mEnv });
  assert(m_addjson_bad.code === 1 && m_addjson_bad.err.includes("not valid"), "mcp add-json invalid JSON");
  const m_addflag = await run("src/mcp-cli.ts", ["add", "envy", "--command", "node", "--env", "A=1", "--env", "B=2", "--cwd", "C:\\", "--", "x.js"], { env: mEnv });
  assert(m_addflag.code === 0, "mcp add with env/cwd flags");
  const impFile = path.join(tmp, "imp.json");
  fs.writeFileSync(impFile, JSON.stringify({ mcpServers: { one: { command: "node" }, two: { url: "https://two.example" }, bad: { nothing: true } } }));
  const m_import = await run("src/mcp-cli.ts", ["import", impFile], { env: mEnv });
  assert(m_import.code === 1 || m_import.code === 0, "mcp import runs");
  assert(m_import.out.includes("one") && m_import.out.includes("invalid"), "mcp import reports");
  const m_disable = await run("src/mcp-cli.ts", ["disable", "fs"], { env: mEnv });
  assert(m_disable.code === 0, "mcp disable");
  const m_enable = await run("src/mcp-cli.ts", ["enable", "fs"], { env: mEnv });
  assert(m_enable.code === 0, "mcp enable");
  const m_test_missing = await run("src/mcp-cli.ts", ["test", "ghost"], { env: mEnv, timeoutMs: 20_000 });
  assert(m_test_missing.code === 1, "mcp test unknown server");
  const m_call_missing = await run("src/mcp-cli.ts", ["call", "fs", "some-tool"], { env: mEnv, timeoutMs: 30_000 });
  assert(m_call_missing.code === 1, "mcp call against unreachable stdio fails cleanly");
  const m_json = await run("src/mcp-cli.ts", ["list", "--json"], { env: mEnv });
  assert(m_json.code === 0 && m_json.out.includes("servers"), "mcp list --json");

  mock.close();
  console.log("CLI TESTS PASSED ✓ (init-config, paths migration, server entry, REPL, mcp-cli)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
