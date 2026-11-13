/**
 * Child runner for the server entry: starts the REAL serve entry in-process
 * (startEnvServer), exercises it and shuts down cleanly so V8 coverage is
 * flushed. Driven by test/cli.test.ts; expects the mock Anthropic env.
 */
import { startEnvServer } from "../../src/server.js";

const key = process.env.AGENT_API_KEY ?? "";
const started = await startEnvServer();
const base = `http://127.0.0.1:${started.port}`;

const health = await fetch(`${base}/health`);
if (!(health.status === 200 && (await health.json()).ok === true)) throw new Error("health failed");

const task = await fetch(`${base}/v1/tasks`, {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "say exactly OK", workdir: process.env.WF_ENTRY_WORKDIR ?? "." }),
});
if (task.status !== 202) throw new Error(`task submit failed: ${task.status}`);
const tid = ((await task.json()) as { task: { id: string } }).task.id;

let final: { status: string; result?: { text?: string } } | undefined;
for (let i = 0; i < 100 && !final; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const t = await fetch(`${base}/v1/tasks/${tid}`, { headers: { Authorization: `Bearer ${key}` } });
  const j = (await t.json()) as { task: { status: string; result?: { text?: string } } };
  if (["completed", "failed", "cancelled", "timed_out"].includes(j.task.status)) final = j.task;
}
if (final?.status !== "completed" || final.result?.text !== "OK") {
  throw new Error(`task did not complete: ${JSON.stringify(final).slice(0, 200)}`);
}

const usage = await fetch(`${base}/v1/usage`, { headers: { Authorization: `Bearer ${key}` } });
if (!(usage.status === 200 && ((await usage.json()) as { five_hour: { percent: number } }).five_hour.percent === 10)) {
  throw new Error("usage endpoint failed");
}

// ---- misc routes (MCP config routes are covered in-process by tasks-core) ----
const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
/** Transient socket resets happen on a busy test machine — retry once. */
const get = async (p: string, headers?: Record<string, string>): Promise<Response> => {
  try {
    return await fetch(`${base}${p}`, { headers });
  } catch {
    await new Promise((r) => setTimeout(r, 750));
    return await fetch(`${base}${p}`, { headers });
  }
};
const toolsList = await get("/v1/tools", auth);
if (toolsList.status !== 200) throw new Error("/v1/tools failed");
const info = await get("/v1/info", auth);
if (info.status !== 200) throw new Error("/v1/info failed");
const unauthorized = await get("/v1/tools");
if (unauthorized.status !== 401) throw new Error("auth required failed");

// oversized body -> 413 (the cap is WRONGFORGE_MAX_BODY_BYTES — the driving
// test spawns the server with a small cap so this check needs no giant upload)
const cap = Number(process.env.WF_EXPECTED_BODY_CAP ?? 40_000_000);
const big = await fetch(`${base}/v1/tasks`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ prompt: "x".repeat(cap + 1000) }),
});
if (big.status !== 413) throw new Error(`oversized body should 413, got ${big.status}: ${await big.text().catch(() => "")}`);

await started.shutdown();
console.log("ENTRY-OK");
setTimeout(() => process.exit(0), 3_000).unref(); // natural exit flushes coverage
