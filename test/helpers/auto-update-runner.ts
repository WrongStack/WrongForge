/**
 * Child runner for the auto-update idle integration test: starts the real
 * serve entry in-process with WRONGFORGE_AUTO_UPDATE=1, submits a slow task,
 * and asserts the poller stays silent while it runs and fires once the
 * server goes idle. Driven by test/auto-update.test.ts.
 *
 * The test seams here force isCompiledBinary() to true (it is always false
 * under tsx) and replace the GitHub call with a fake "newer release" whose
 * asset points at a port nothing answers — prepareUpdate()'s download fails
 * there, so this never reaches installUpdate(), which would process.exit()
 * this very process.
 */
import { lastUpdateCheck, setIsCompiledBinaryForTest, setLatestReleaseForTest, type ReleaseInfo } from "../../src/update.js";
import { ClaudeOAuth } from "../../src/oauth.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// startEnvServer() builds its own ClaudeOAuth from CLAUDE_TOKEN_STORE; sign
// it in against the fake server BEFORE starting the real one reads the same
// file, so task submission (which requires oauth.signedIn) is allowed.
const presignIn = new ClaudeOAuth(process.env.CLAUDE_TOKEN_STORE);
await presignIn.exchangeCode("code", "verifier", "https://console.anthropic.com/oauth/code/callback", "user:inference user:profile");

let prepareCalls = 0;
const newer: ReleaseInfo = {
  current: "0.0.1",
  latest: "99.0.0",
  url: "https://example.invalid/releases/99.0.0",
  notes: "",
  asset: { name: "fake-asset", url: "http://127.0.0.1:1/nope", digest: `sha256:${"0".repeat(64)}`, size: 10 },
};
setIsCompiledBinaryForTest(true);
setLatestReleaseForTest(async () => {
  prepareCalls++;
  return newer;
});

const { startEnvServer } = await import("../../src/server.js");
const key = process.env.AGENT_API_KEY ?? "";
const started = await startEnvServer();
const base = `http://127.0.0.1:${started.port}`;

const api = async (method: string, p: string, body?: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// Submit BEFORE waiting for the startup check: with a task already queued,
// the poller must stay silent no matter when the check lands. The old order
// (wait for the check, then submit) left an idle window that a heavily
// loaded machine could tick into and run prepareUpdate() in (F2105).
const sub = await api("POST", "/v1/tasks", { workdir: process.env.WF_ENTRY_WORKDIR ?? ".", prompt: "[[delay 1500]] [[say done]]" });
if (sub.status !== 202) throw new Error(`task submit failed: ${sub.status} ${JSON.stringify(sub.body)}`);
const taskId = sub.body.task.id;

// wait for the startup check (announceUpdate) to populate lastUpdateCheck()
const t0 = Date.now();
while (!lastUpdateCheck() && Date.now() - t0 < 5000) await sleep(25);
if (!lastUpdateCheck()) throw new Error("startup update check never completed");
prepareCalls = 0; // that was the startup check, not the idle poller — and the task has been in the queue all along

await sleep(300); // several WRONGFORGE_AUTO_UPDATE_POLL_MS ticks while the task runs
if (prepareCalls !== 0) throw new Error(`prepareUpdate() ran while a task was in flight (${prepareCalls} calls)`);

let status = "";
const t1 = Date.now();
while (Date.now() - t1 < 10_000) {
  const r = await api("GET", `/v1/tasks/${taskId}`);
  status = r.body?.task?.status;
  if (status === "completed" || status === "failed") break;
  await sleep(25);
}
if (status !== "completed") throw new Error(`the task did not complete (status=${status})`);

const t2 = Date.now();
while (prepareCalls === 0 && Date.now() - t2 < 3000) await sleep(25);
if (prepareCalls === 0) throw new Error("prepareUpdate() never ran after the server went idle");

await started.shutdown();
console.log("AUTO-UPDATE-OK");
setTimeout(() => process.exit(0), 3_000).unref(); // natural exit flushes coverage
