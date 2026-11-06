/**
 * `wrongforge mcp-server` end-to-end: spawns the real stdio entry as a child,
 * connects with the MCP SDK client (the same way Claude Code would), and
 * drives WrongForge through the exposed tools — list, submit+wait, get,
 * events, usage summary. Everything runs against a harness server + Fake.
 *
 *   npx tsx test/mcp-server.test.ts
 */

import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { assert, sleep, startHarness, type Harness } from "./helpers/harness.js";

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");
const TSX = process.execPath;
const TSX_ARGS = [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs")];

const text = (result: any): any => {
  assert(!result.isError, `tool call errored: ${result.content?.[0]?.text}`);
  return JSON.parse(result.content[0].text);
};

async function main(): Promise<void> {
  const h = await startHarness({ app: { maxConcurrency: 2 }, defaultWorkdir: undefined });
  const d = h.mkdir("mcp");

  const client = new Client({ name: "wf-mcp-test", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: TSX,
    args: [...TSX_ARGS, path.join(ROOT, "src", "main.ts"), "mcp-server"],
    env: {
      ...process.env,
      WRONGFORGE_URL: h.base,
      WRONGFORGE_API_KEY: h.key,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined); // drain: keep the pipe from backing up
  const t0 = Date.now();
  await client.connect(transport);
  assert(Date.now() - t0 < 15_000, "the stdio handshake completes quickly");

  // ---- tools/list
  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name).sort();
  assert(
    JSON.stringify(names) === JSON.stringify(["cancel_task", "get_task", "list_sessions", "list_tasks", "submit_task", "task_events", "usage_summary", "wait_task"]),
    `tools/list exposes the registry (got ${names.join(", ")})`,
  );

  // ---- submit_task with wait=true: blocks to completion, returns the final document
  const submitted = await client.callTool({
    name: "submit_task",
    arguments: { prompt: "[[usage 100]] [[say mcp-done]]", workdir: d, wait: true, effort: "off" },
  });
  const done = text(submitted);
  assert(done.status === "completed", `wait=true returned the finished task (got ${done.status})`);
  assert(String(done.result?.text ?? "").includes("mcp-done"), "the result text came through");

  // ---- get_task on it
  const got = text(await client.callTool({ name: "get_task", arguments: { task_id: done.id } }));
  assert(got.id === done.id && got.status === "completed", "get_task returns the same document");

  // ---- unknown task surfaces a tool error (isError content, not a throw)
  const missing = await client.callTool({ name: "get_task", arguments: { task_id: "tsk_no_such" } });
  assert(missing.isError === true && String(missing.content?.[0]?.text).includes("no task"), "unknown task -> isError content");

  // ---- list_tasks + task_events
  const list = text(await client.callTool({ name: "list_tasks", arguments: { status: "completed", limit: 10 } }));
  assert((list.tasks ?? []).some((t: any) => t.id === done.id), "list_tasks finds the finished task");
  const events = text(await client.callTool({ name: "task_events", arguments: { task_id: done.id, limit: 30 } }));
  assert((events.events ?? []).length > 0 && events.events.some((e: any) => e.type === "task.completed"), "task_events carries the lifecycle");

  // ---- wait_task on a second task (submit without wait, then wait via tool)
  const t2 = text(await client.callTool({ name: "submit_task", arguments: { prompt: "[[say second]]", workdir: d } }));
  const waited = text(await client.callTool({ name: "wait_task", arguments: { task_id: t2.id, timeout_ms: 20_000 } }));
  assert(waited.status === "completed", "wait_task blocks to completion");

  // ---- usage_summary sees the tasks the MCP client submitted
  await sleep(150);
  const usage = text(await client.callTool({ name: "usage_summary", arguments: { days: 1 } }));
  assert(usage.totals.completed >= 2 && usage.totals.input_tokens > 0, `usage_summary aggregates the MCP-driven tasks (got ${JSON.stringify(usage.totals)})`);

  // ---- cancel path
  const t3 = text(await client.callTool({ name: "submit_task", arguments: { prompt: "[[delay 3000]] [[say slow]]", workdir: d } }));
  const cancelled = text(await client.callTool({ name: "cancel_task", arguments: { task_id: t3.id, reason: "mcp test" } }));
  assert(cancelled.task.status === "cancelled", "cancel_task stops a running task");

  await client.close();
  await h.close();
  console.log("MCP SERVER TESTS PASSED ✓ (stdio handshake, tools/list registry, submit+wait, get/list/events, wait_task, usage_summary, cancel)");
  process.exit(0);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
