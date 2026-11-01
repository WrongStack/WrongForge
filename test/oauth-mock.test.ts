/**
 * Offline end-to-end test: with a fake token + messages server, verify
 * exchange -> (on expiry) proactive refresh -> oauthFetch header injection.
 *
 *   npx tsx test/oauth-mock.test.ts
 */

import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { ClaudeOAuth, CLAUDE_CODE_UA, parsePastedCode, setKeychainReaderForTest } from "../src/oauth.js";
import { maxRetriesFromEnv, oauthFetch } from "../src/provider.js";
import { effortCap, effortRejectedOnce, resetEffortRejections } from "../src/effort.js";
import { runInContext } from "../src/context.js";

// Temp dirs live under the OS temp dir and are removed on exit (pass or fail).
const tmpDirs: string[] = [];
function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
process.on("exit", () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

// console.assert only logs; this throws so a failed check fails the test.
function check(cond: unknown, label: string): void {
  if (!cond) throw new Error(`assertion failed: ${label}`);
}

// --- maxRetriesFromEnv: unset/default/clamped ---
check(maxRetriesFromEnv({}) === 2, "default is the SDK's 2");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "5" }) === 5, "env value taken");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "0" }) === 0, "0 disables retries");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "99" }) === 10, "clamped high to 10");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "-3" }) === 0, "clamped low to 0");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "abc" }) === 2, "garbage falls back to the default");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "" }) === 2, "empty falls back to the default");
check(maxRetriesFromEnv({ WRONGFORGE_MAX_RETRIES: "2.9" }) === 2, "floored");

// --- parsePastedCode: "code#state" is what the redirect page shows ---
check(parsePastedCode("ABC", "S") === "ABC", "bare code accepted");
check(
  parsePastedCode("ABC#S", "S") === "ABC",
  "code#state splits and state validates",
);
check(
  parsePastedCode("https://x/cb?code=ABC&state=S", "S") === "ABC",
  "full callback URL accepted",
);
try {
  parsePastedCode("ABC#OTHER", "S");
  check(false, "state mismatch must throw");
} catch (e) {
  check(/state mismatch/.test((e as Error).message), "state mismatch error");
}
let emptyThrew = false;
try {
  parsePastedCode("   ", "S");
} catch {
  emptyThrew = true;
}
check(emptyThrew, "empty code must throw");

function main(): Promise<void> {
  return new Promise((resolve, reject) => {
    const seen: {
      tokenRequests: any[];
      messagesHeaders: http.IncomingHttpHeaders | null;
    } = { tokenRequests: [], messagesHeaders: null };
    let tokenCall = 0;

    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url === "/v1/oauth/token") {
          seen.tokenRequests.push({
            headers: req.headers,
            body: JSON.parse(body),
          });
          tokenCall++;
          // first call: 429 with Retry-After: 0 (exercises the retry path),
          // then a 1s-TTL token (proactive refresh), then a 1h token
          if (tokenCall === 1) {
            res.writeHead(429, {
              "Content-Type": "application/json",
              "Retry-After": "0",
            });
            res.end(
              JSON.stringify({
                error: { type: "rate_limit_error", message: "Rate limited. Please try again later." },
              }),
            );
            return;
          }
          const exchange = tokenCall === 2;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              access_token: exchange ? "at-1" : "at-2",
              refresh_token: exchange ? "rt-1" : "rt-2",
              expires_in: exchange ? 1 : 3600,
              scope: "user:inference user:profile",
            }),
          );
          return;
        }
        if (req.url?.startsWith("/v1/messages")) {
          seen.messagesHeaders = req.headers;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_test",
              type: "message",
              role: "assistant",
              content: [{ type: "text", text: "ok" }],
              model: "claude-sonnet-5-5",
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      });
    });

    server.listen(0, "127.0.0.1", async () => {
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const base = `http://127.0.0.1:${port}`;
        process.env.ANTHROPIC_TOKEN_URL = `${base}/v1/oauth/token`;
        process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";
        const store = path.join(
          mkTmp("wrongminiagent-login-test-"),
          "tokens.json",
        );
        const oauth = new ClaudeOAuth(store);

        // 1) authorization_code exchange (first attempt is a 429 that is retried)
        await oauth.exchangeCode(
          "test-code",
          "test-verifier",
          "https://console.anthropic.com/oauth/code/callback",
          "user:inference user:profile",
          "test-state",
        );
        check(
          seen.tokenRequests.length >= 2 &&
            seen.tokenRequests.every((t: any) => t.body.grant_type === "authorization_code"),
          "429 was retried with the same grant",
        );
        const ex = seen.tokenRequests[1];
        check(
          ex.body.grant_type === "authorization_code" &&
            ex.body.code === "test-code" &&
            ex.body.code_verifier === "test-verifier" &&
            ex.body.state === "test-state" &&
            ex.body.client_id === "test-client-id",
          "exchange body is correct",
        );
        check(
          String(ex.headers["content-type"]).includes("application/json"),
          "token endpoint receives a JSON body",
        );
        check(
          ex.headers["user-agent"] === CLAUDE_CODE_UA,
          "token endpoint receives the Claude Code User-Agent (the generic anthropic UA is what it 429s)",
        );
        check(
          !("authorization" in ex.headers),
          "no Bearer on the token exchange (nor on refresh)",
        );

        // 2) 1s TTL -> proactive refresh must kick in
        await new Promise((r) => setTimeout(r, 1100));
        const token = await oauth.getAccessToken();
        if (token !== "at-2") throw new Error(`refresh did not happen: ${token}`);
        const rf = seen.tokenRequests[2];
        check(
          rf.body.grant_type === "refresh_token" &&
            rf.body.refresh_token === "rt-1" &&
            rf.body.scope === "user:inference user:profile",
          "refresh body is correct (incl. the granted scope, like Claude Code)",
        );

        // 3) oauthFetch: Bearer + beta injection
        const f = oauthFetch(oauth);
        const res = await f(`${base}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": "must-not-be-seen",
            "anthropic-beta": "interleaved-thinking-2025-05-14",
          },
          body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
        });
        if (res.status !== 200) throw new Error(`messages HTTP ${res.status}`);
        const h = seen.messagesHeaders!;
        check(
          h["authorization"] === "Bearer at-2",
          `Bearer injected: ${h["authorization"]}`,
        );
        check(
          !h["x-api-key"],
          "x-api-key stripped",
        );
        const beta = String(h["anthropic-beta"]);
        check(
          beta.includes("oauth-2025-04-20") &&
            beta.includes("interleaved-thinking-2025-05-14"),
          `beta headers merged: ${beta}`,
        );

        // 3b) retryable upstream statuses surface as a task-visible
        //     agent.report (issue #7: the SDK's silent retries left RUNNING
        //     tasks without any event while the backend answered 503)
        {
          const reports: any[] = [];
          let hits = 0;
          const busy = http.createServer((_req, res) => {
            hits++;
            res.writeHead(503, { "content-type": "application/json", "retry-after": "3" });
            res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "model busy" } }));
          });
          busy.listen(0, "127.0.0.1");
          await new Promise<void>((r) => busy.once("listening", () => r()));
          const busyBase = `http://127.0.0.1:${(busy.address() as { port: number }).port}`;
          const post = (extra: Record<string, string> = {}): RequestInit => ({
            method: "POST",
            headers: { "content-type": "application/json", ...extra },
            body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
          });

          await runInContext({ cwd: process.cwd(), env: {}, todos: [], report: (r) => reports.push(r) }, async () => {
            const res = await f(`${busyBase}/v1/messages`, post());
            check(res.status === 503, "the 503 response passes through untouched");
          });
          check(hits === 1, `exactly one upstream hit so far (${hits})`);
          check(reports.length === 1 && reports[0].phase === "retry", `first attempt reports once (phase retry): ${JSON.stringify(reports)}`);
          check(
            /upstream 503/.test(reports[0].message) && /retries on its own \(2 left\)/.test(reports[0].message) && /wait 3s/.test(reports[0].message),
            `first-attempt message has status, retries left and retry-after: ${reports[0].message}`,
          );

          reports.length = 0;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [], report: (r) => reports.push(r) }, async () => {
            await f(`${busyBase}/v1/messages`, post({ "x-stainless-retry-count": "1" }));
          });
          check(reports.length === 1 && /\(1 left\)/.test(reports[0].message), `attempt 1 reports one retry left: ${reports[0].message}`);

          reports.length = 0;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [], report: (r) => reports.push(r) }, async () => {
            await f(`${busyBase}/v1/messages`, post({ "x-stainless-retry-count": "2" }));
          });
          check(reports.length === 1 && /retries exhausted/.test(reports[0].message), `last attempt reports exhaustion: ${reports[0].message}`);

          reports.length = 0;
          const outside = await f(`${busyBase}/v1/messages`, post());
          check(outside.status === 503 && reports.length === 0, "outside a task context there is no report channel and no crash");

          // WRONGFORGE_MAX_RETRIES moves the budget the messages quote (and
          // createClaudeClient hands the SDK)
          process.env.WRONGFORGE_MAX_RETRIES = "1";
          reports.length = 0;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [], report: (r) => reports.push(r) }, async () => {
            await f(`${busyBase}/v1/messages`, post());
          });
          check(reports.length === 1 && /\(1 left\)/.test(reports[0].message), `maxRetries=1: one retry left: ${reports[0].message}`);
          process.env.WRONGFORGE_MAX_RETRIES = "0";
          reports.length = 0;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [], report: (r) => reports.push(r) }, async () => {
            await f(`${busyBase}/v1/messages`, post());
          });
          check(reports.length === 1 && /retries exhausted/.test(reports[0].message), `maxRetries=0: exhausted on the first attempt: ${reports[0].message}`);
          delete process.env.WRONGFORGE_MAX_RETRIES;

          busy.close();
        }

        // 3c) effort-cap step-down (F2101, findings.md §21): an org-admin cap
        //     answers "Invalid effort level" — the provider steps the level
        //     down per retry (high → medium → …), learns the working level as
        //     a per-model cap, and the caller only ever sees the success
        {
          resetEffortRejections();
          const seen: (string | undefined)[] = [];
          let status = 200;
          const capped = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              let level: string | undefined;
              try {
                level = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.output_config?.effort;
              } catch {
                /* unparseable */
              }
              seen.push(level);
              const cappedAt = "low";
              if (level && level !== cappedAt) {
                status = 400;
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid effort level: accounts on this plan support at most low." } }));
                return;
              }
              status = 200;
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ id: "msg_ok", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
            });
          });
          capped.listen(0, "127.0.0.1");
          await new Promise<void>((r) => capped.once("listening", () => r()));
          const capBase = `http://127.0.0.1:${(capped.address() as { port: number }).port}`;
          const capPost = (): RequestInit => ({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [] }),
          });

          const reports: any[] = [];
          await runInContext({ cwd: process.cwd(), env: {}, todos: [], report: (r) => reports.push(r) }, async () => {
            const res = await f(`${capBase}/v1/messages`, capPost());
            check(res.status === 200, `the caller sees the stepped-down success (got ${res.status})`);
          });
          check(JSON.stringify(seen) === JSON.stringify(["high", "medium", "low"]), `attempt ladder: high → medium → low ok (got ${JSON.stringify(seen)})`);
          check(effortCap("claude-sonnet-5-5") === "low", `the learned cap is low (got ${effortCap("claude-sonnet-5-5")})`);
          check(!effortRejectedOnce("claude-sonnet-5-5"), "the cap path does NOT disable effort");

          // a follow-up request clamps straight to the cap — no probe repaid
          seen.length = 0;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [] }, async () => {
            const res = await f(`${capBase}/v1/messages`, capPost());
            check(res.status === 200, "the follow-up request succeeds");
          });
          check(JSON.stringify(seen) === JSON.stringify(["low"]), `follow-up sends the capped level directly (got ${JSON.stringify(seen)})`);

          // a GENERIC effort refusal (parameter not supported) still takes the old off-path
          resetEffortRejections();
          seen.length = 0;
          const noEffort = http.createServer((_req, res) => {
            seen.push("hit");
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "output_config.effort: Extra inputs are not permitted" } }));
          });
          noEffort.listen(0, "127.0.0.1");
          await new Promise<void>((r) => noEffort.once("listening", () => r()));
          const noEffortBase = `http://127.0.0.1:${(noEffort.address() as { port: number }).port}`;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [] }, async () => {
            const res = await f(`${noEffortBase}/v1/messages`, capPost());
            check(res.status === 400, "the off-path cannot rescue a body the caller owns — the 400 passes through");
          });
          check(effortRejectedOnce("claude-sonnet-5-5"), "a generic effort refusal still disables effort for the model");
          check(seen.length === 2, `exactly one retry was paid (got ${seen.length})`);
          noEffort.close();

          // a CALLER-OWNED body level (a proxied client's own output_config.effort)
          // walks the ladder by rewriting its body, and once the cap is learned a
          // client level above it is clamped proactively (no guaranteed-400 probe)
          resetEffortRejections();
          seen.length = 0;
          const capPostOwned = (level: string): RequestInit => ({
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [], output_config: { effort: level } }),
          });
          capped.close();
          const capped2 = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              let level: string | undefined;
              try {
                level = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.output_config?.effort;
              } catch {
                /* unparseable */
              }
              seen.push(level);
              if (level && level !== "medium") {
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Invalid effort level: accounts on this plan support at most medium." } }));
                return;
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ id: "msg_ok", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-sonnet-5-5", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
            });
          });
          capped2.listen(0, "127.0.0.1");
          await new Promise<void>((r) => capped2.once("listening", () => r()));
          const cap2Base = `http://127.0.0.1:${(capped2.address() as { port: number }).port}`;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [] }, async () => {
            const res = await f(`${cap2Base}/v1/messages`, capPostOwned("max"));
            check(res.status === 200, `a caller-owned max walks down to the cap (got ${res.status})`);
          });
          check(JSON.stringify(seen) === JSON.stringify(["max", "xhigh", "high", "medium"]), `owned-body ladder walks the body itself (got ${JSON.stringify(seen)})`);
          check(effortCap("claude-sonnet-5-5") === "medium", `the owned-body walk learns the cap (got ${effortCap("claude-sonnet-5-5")})`);
          seen.length = 0;
          await runInContext({ cwd: process.cwd(), env: {}, todos: [] }, async () => {
            const res = await f(`${cap2Base}/v1/messages`, capPostOwned("max"));
            check(res.status === 200, "the second owned request succeeds");
          });
          check(JSON.stringify(seen) === JSON.stringify(["medium"]), `a learned cap clamps a client-owned level proactively (got ${JSON.stringify(seen)})`);
          capped2.close();
          capped.close();
        }

        // 4) import from a Claude Code credentials file (no network)
        const credFile = path.join(
          mkTmp("claude-import-test-"),
          ".credentials.json",
        );
        fs.writeFileSync(
          credFile,
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "imported-at",
              refreshToken: "imported-rt",
              expiresAt: Date.now() + 3600_000,
              scopes: ["user:inference", "user:profile"],
            },
          }),
        );
        const oauth2 = new ClaudeOAuth(path.join(path.dirname(credFile), "tokens.json"));
        const imported = oauth2.importFromClaudeCode(credFile);
        if (imported.accessToken !== "imported-at") throw new Error("import failed");
        const viaImport = await oauth2.getAccessToken();
        if (viaImport !== "imported-at") throw new Error("imported token not usable");
        check(oauth2.signedIn, "import marks the session as signed in");

        // 4b) a malformed/corrupted credentials file must not crash the import
        // nor be accepted as "this token lives forever" (F504): expiresAt as a
        // numeric literal too large for a double rounds to Infinity, which
        // `typeof x === "number"` alone does not catch.
        {
          const credFileBad = path.join(mkTmp("claude-import-badexp-"), ".credentials.json");
          fs.writeFileSync(
            credFileBad,
            '{"claudeAiOauth":{"accessToken":"bad-exp-at","refreshToken":"bad-exp-rt","expiresAt":1e400,"scopes":["user:inference"]}}',
          );
          const oauthBad = new ClaudeOAuth(path.join(path.dirname(credFileBad), "tokens.json"));
          const importedBad = oauthBad.importFromClaudeCode(credFileBad); // must not throw
          check(Number.isFinite(importedBad.expiresAt), "a non-finite expiresAt falls back to a finite default instead of crashing or living forever");
          check(importedBad.accessToken === "bad-exp-at", "the rest of a malformed-expiresAt import still succeeds");
        }

        // 5) self-healing: a rejected refresh token adopts Claude Code's session
        {
          let ccRefreshes = 0;
          let tokenCalls = 0;
          const dead = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              tokenCalls++;
              const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (b.grant_type === "refresh_token" && b.refresh_token === "dead-rt") {
                res.writeHead(400, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_grant", error_description: "refresh token expired" }));
                return;
              }
              ccRefreshes++;
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ access_token: "recovered-at", refresh_token: "cc-rt-2", expires_in: 3600, scope: "user:inference" }));
            });
          });
          await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
          const prevTokenUrl = process.env.ANTHROPIC_TOKEN_URL;
          const prevCred = process.env.CLAUDE_CREDENTIALS_FILE;
          try {
            process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${(dead.address() as any).port}/v1/oauth/token`;
            const home = mkTmp("wf-recovery-");
            const seedDead = path.join(home, "dead-session.json");
            fs.writeFileSync(seedDead, JSON.stringify({ claudeAiOauth: { accessToken: "old-at", refreshToken: "dead-rt", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));
            const ccAlive = path.join(home, "cc-alive.json");
            // Claude Code's session: its access token is expired too, but its
            // refresh token still works — exactly the "run CC once" state
            fs.writeFileSync(ccAlive, JSON.stringify({ claudeAiOauth: { accessToken: "cc-stale-at", refreshToken: "cc-rt", expiresAt: Date.now() - 1000, scopes: ["user:inference"] } }));

            const oauth3 = new ClaudeOAuth(path.join(home, "tokens3.json"));
            oauth3.importFromClaudeCode(seedDead); // a dead session, manually seeded
            process.env.CLAUDE_CREDENTIALS_FILE = ccAlive;
            const got = await oauth3.getAccessToken();
            check(got === "recovered-at", "a rejected refresh adopts Claude Code's session and refreshes it");
            check(ccRefreshes === 1, "recovery used exactly one refresh call");
            check(oauth3.signedIn, "recovery keeps the session signed in");
            const again = await oauth3.getAccessToken();
            check(again === "recovered-at" && ccRefreshes === 1, "the recovered token is used without further refreshes");

            // nothing left to recover from: Claude Code's refresh is dead too
            const oauth4 = new ClaudeOAuth(path.join(home, "tokens4.json"));
            oauth4.importFromClaudeCode(seedDead);
            process.env.CLAUDE_CREDENTIALS_FILE = seedDead; // CC holds the same dead token
            const before = tokenCalls;
            let msg = "";
            try {
              await oauth4.getAccessToken();
            } catch (e) {
              msg = (e as Error).message;
            }
            check(/npm run import/.test(msg), `unrecoverable refresh tells the user what to run (${msg})`);
            check(tokenCalls === before + 2, "doomed refresh + one recovery attempt, then it gives up");
            await oauth4.getAccessToken().catch(() => {});
            check(tokenCalls === before + 3, "recovery stays exhausted — later calls only pay the doomed refresh");
          } finally {
            process.env.ANTHROPIC_TOKEN_URL = prevTokenUrl;
            if (prevCred === undefined) delete process.env.CLAUDE_CREDENTIALS_FILE;
            else process.env.CLAUDE_CREDENTIALS_FILE = prevCred;
            dead.close();
          }
        }

        // 6) a stale in-flight refresh must not overwrite a newer login
        //    (F501 — gated completion order: the refresh reply is released
        //    only AFTER the new login has been installed; no sleeps)
        {
          const held: (() => void)[] = [];
          let arrived!: () => void;
          const arriving = new Promise<void>((r) => (arrived = r));
          let seq = 0;
          const raceSrv = http.createServer((req, res) => {
            const chunks: Buffer[] = [];
            req.on("data", (c: Buffer) => chunks.push(c));
            req.on("end", () => {
              const b = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              res.writeHead(200, { "Content-Type": "application/json" });
              if (b.grant_type === "refresh_token") {
                arrived();
                held.push(() =>
                  res.end(
                    JSON.stringify({
                      access_token: `at-stale-${seq}`,
                      refresh_token: `rt-stale-${seq}`,
                      expires_in: 3600,
                      scope: "user:inference",
                    }),
                  ),
                );
                return;
              }
              res.end(
                JSON.stringify({
                  access_token: `at-login-${seq}`,
                  refresh_token: `rt-login-${seq}`,
                  expires_in: 3600,
                  scope: "user:inference",
                }),
              );
            });
          });
          await new Promise<void>((r) => raceSrv.listen(0, "127.0.0.1", r));
          const racePort = (raceSrv.address() as any).port;
          const prevRace = process.env.ANTHROPIC_TOKEN_URL;
          const home = mkTmp("wf-race-");
          try {
            process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${racePort}/v1/oauth/token`;
            const store = path.join(home, "race-tokens.json");
            const oauth5 = new ClaudeOAuth(store);
            await oauth5.exchangeCode("c1", "v1", "https://console.anthropic.com/oauth/code/callback", "user:inference");
            seq = 1;
            (oauth5 as any).token.expiresAt = Date.now() - 1000; // force a refresh

            const inflight = oauth5.refresh(); // do NOT await
            await arriving; // barrier: the refresh request is in flight
            const newer = await oauth5.exchangeCode("c2", "v2", "https://console.anthropic.com/oauth/code/callback", "user:inference");
            held.shift()!(); // only NOW let the stale refresh land
            await inflight;

            check(
              (await oauth5.getAccessToken()) === newer.accessToken,
              "a refresh that lands after a newer login must not overwrite it",
            );
            check(
              (await new ClaudeOAuth(store).getAccessToken()) === newer.accessToken,
              "the newer login survives on disk too",
            );
          } finally {
            process.env.ANTHROPIC_TOKEN_URL = prevRace;
            raceSrv.close();
          }
        }

        // 7) import falls back to the macOS Keychain when the credentials
        //    file is gone (Claude Code 2.1.302+, issue #3) — reader swapped
        //    in so non-macOS machines exercise the same path
        {
          const kc = JSON.stringify({
            claudeAiOauth: { accessToken: "kc-at", refreshToken: "kc-rt", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] },
          });
          const home = mkTmp("wf-keychain-");
          const missing = path.join(home, ".claude", ".credentials.json");
          try {
            setKeychainReaderForTest(() => kc);
            const oauth6 = new ClaudeOAuth(path.join(home, "tokens6.json"));
            const t = oauth6.importFromClaudeCode(missing);
            check(t.accessToken === "kc-at" && t.refreshToken === "kc-rt", "keychain JSON (file shape) imported");
            check((await oauth6.getAccessToken()) === "kc-at", "keychain-imported token is usable");

            const oauth7 = new ClaudeOAuth(path.join(home, "tokens7.json"));
            setKeychainReaderForTest(() =>
              JSON.stringify({ accessToken: "bare-at", refreshToken: "bare-rt", expiresAt: Date.now() + 3600_000, scopes: ["user:inference"] }),
            );
            check(oauth7.importFromClaudeCode(missing).accessToken === "bare-at", "keychain JSON (bare shape) imported");

            const oauth8 = new ClaudeOAuth(path.join(home, "tokens8.json"));
            setKeychainReaderForTest(() => `\uFEFF${kc}\n`);
            check(oauth8.importFromClaudeCode(missing).accessToken === "kc-at", "keychain BOM/newlines tolerated");

            setKeychainReaderForTest(() => null);
            let msg = "";
            try {
              await new ClaudeOAuth(path.join(home, "tokens9.json")).importFromClaudeCode(missing);
            } catch (e) {
              msg = (e as Error).message;
            }
            check(/cannot read/.test(msg) && msg.includes(missing), `missing file + empty keychain -> the read error (${msg})`);

            setKeychainReaderForTest(() => "not json {");
            let msg2 = "";
            try {
              await new ClaudeOAuth(path.join(home, "tokens10.json")).importFromClaudeCode(missing);
            } catch (e) {
              msg2 = (e as Error).message;
            }
            check(/not valid JSON/.test(msg2) && /Keychain/.test(msg2), `garbage keychain -> the JSON error names the source (${msg2})`);
          } finally {
            setKeychainReaderForTest(null);
          }
        }

        // 8) getAccessToken(margin): a wide margin refreshes a still-valid
        //    token NOW — the server's idle keep-alive rides this contract
        //    instead of waiting for the last 60 seconds
        {
          const oauth9 = new ClaudeOAuth(path.join(mkTmp("wf-margin-"), "tokens.json"));
          await oauth9.exchangeCode("c9", "v9", "https://console.anthropic.com/oauth/code/callback", "user:inference");
          const callsBefore = tokenCall;
          const t = await oauth9.getAccessToken(61 * 60_000);
          check(t === "at-2" && tokenCall === callsBefore + 1, "a wide refresh margin triggers an immediate refresh");
          const t2 = await oauth9.getAccessToken();
          check(t2 === "at-2" && tokenCall === callsBefore + 1, "the default margin leaves a fresh token alone");
        }

        server.close();
        console.log("ALL TESTS PASSED ✓ (exchange, refresh, header injection, retry visibility, effort caps, import, Keychain fallback, refresh-token recovery, stale-refresh race, keep-alive margin)");
        resolve();
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

/**
 * refreshTokenExpiresAt: parsed from refresh_token_expires_in when the token
 * endpoint sends it (the exchange response here), carried forward — not
 * cleared — when a later refresh response omits it (mirrors CC's own merge;
 * re/notes/findings.md §14, mod-0150 jPr()/yE()).
 */
function testRefreshTokenExpiry(): Promise<void> {
  return new Promise((resolve, reject) => {
    let call = 0;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        call++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            access_token: `rte-at-${call}`,
            refresh_token: `rte-rt-${call}`,
            expires_in: 3600,
            scope: "user:inference",
            // call 1 (exchange) sends it; call 2+ (refresh) omits it — the
            // previously stored value must survive, not be cleared.
            ...(call === 1 ? { refresh_token_expires_in: 2_592_000 } : {}),
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", async () => {
      try {
        const port = (server.address() as http.AddressInfo).port;
        process.env.ANTHROPIC_TOKEN_URL = `http://127.0.0.1:${port}/v1/oauth/token`;
        process.env.CLAUDE_OAUTH_CLIENT_ID = "test-client-id";
        const oauth = new ClaudeOAuth(path.join(mkTmp("wf-rte-"), "tokens.json"));
        await oauth.exchangeCode("c", "v", "https://console.anthropic.com/oauth/code/callback", "user:inference");
        const s1 = oauth.status() as { refreshTokenExpiresAt: number | null };
        check(
          typeof s1.refreshTokenExpiresAt === "number" && s1.refreshTokenExpiresAt > Date.now(),
          "refresh_token_expires_in from the exchange is recorded on status()",
        );
        const before = s1.refreshTokenExpiresAt;
        await oauth.getAccessToken(61 * 60_000); // wide margin forces an immediate refresh
        const s2 = oauth.status() as { refreshTokenExpiresAt: number | null };
        check(
          s2.refreshTokenExpiresAt === before,
          "a refresh response that omits refresh_token_expires_in keeps the previous value",
        );
        server.close();
        console.log("REFRESH-TOKEN-EXPIRY TESTS PASSED ✓ (recorded on exchange, survives a refresh that omits it)");
        resolve();
      } catch (e) {
        server.close();
        reject(e);
      }
    });
  });
}

main()
  .then(testRefreshTokenExpiry)
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
