/**
 * Core task API test (offline: fake Anthropic + the real server).
 *
 *   npx tsx test/tasks-core.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Fake, assert, parseSse, sleep, startHarness, startReceiver } from "./helpers/harness.js";
import { TaskStore } from "../src/tasks/store.js";
import { gzipFile } from "../src/log.js";

const tool = (name: string, input: unknown): string => `[[tool ${name} ${JSON.stringify(input)}]]`;
const types = (events: any[]): string[] => events.map((e) => e.type);

/** Drops cache_control markers (they mark breakpoints, they are not part of the cached content). */
const stripCc = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "cache_control" ? undefined : x)));

async function main(): Promise<void> {
  const fake = new Fake();
  await fake.start();
  const h = await startHarness({ fake });
  const dirA = h.mkdir("a");
  fs.writeFileSync(path.join(dirA, "hello.txt"), "hi");
  const post = (body: Record<string, unknown>) => h.api("POST", "/v1/tasks", { workdir: dirA, ...body });

  // ============================================================ auth / info
  const health = await fetch(`${h.base}/health`);
  const hb = await health.json();
  assert(health.status === 200 && hb.ok === true && hb.name === "WrongForge", "health needs no key");
  const noKey = await fetch(`${h.base}/v1/info`);
  assert(noKey.status === 401 && (await noKey.json()).error.code === "unauthorized", "401 without key, error envelope");
  assert((await fetch(`${h.base}/v1/info`, { headers: { Authorization: "Bearer wrong-key-wrong-key" } })).status === 401, "401 with a wrong key");
  const info = (await h.api("GET", "/v1/info")).body;
  assert(info.protocol === 1 && info.workdir.required === true && info.default_model === "claude-sonnet-5-5", "info: protocol, workdir required, model");
  const detail = (info.model_details ?? []).find((m: any) => m.id === "claude-sonnet-5-5");
  assert(
    detail && Array.isArray(detail.effort_levels) && detail.effort_levels.join(",") === "low,medium,high,xhigh,max" && typeof detail.description === "string",
    "info.model_details carries per-model effort levels (5 for sonnet-5-5)",
  );
  assert(info.tools.includes("report_progress") && info.tools.includes("mcp_call") && info.cache.default === "1h", "info lists tools and cache default");
  assert(info.effort.default === "high" && info.features.includes("effort"), "info lists the effort default and feature");
  assert((await h.api("GET", "/v1/tools")).body.tools.some((t: any) => t.name === "bash"), "/v1/tools");
  assert((await h.api("GET", "/v1/nope")).status === 404, "unknown route -> 404");

  // ============================================================ validation
  const bad = async (body: unknown, status: number, code: string, label: string): Promise<void> => {
    const r = await h.api("POST", "/v1/tasks", body);
    assert(r.status === status && r.body.error.code === code, `${label} -> ${status} ${code} (got ${r.status} ${r.body?.error?.code})`);
  };
  await bad({ workdir: dirA }, 400, "invalid_request", "missing prompt");
  await bad({ prompt: "x" }, 400, "workdir_required", "missing workdir");
  await bad({ prompt: "x", workdir: path.join(dirA, "nope") }, 400, "invalid_workdir", "workdir that does not exist");
  await bad({ prompt: "x", workdir: path.join(dirA, "hello.txt") }, 400, "invalid_workdir", "workdir that is a file");
  await bad({ prompt: "x", workdir: dirA, cache: "forever" }, 400, "invalid_request", "bad cache mode");
  await bad({ prompt: "x", workdir: dirA, effort: "turbo" }, 400, "invalid_request", "bad effort");
  await bad({ prompt: "x", workdir: dirA, session_id: "../evil" }, 400, "invalid_request", "path traversal in session_id");
  await bad({ prompt: "x", workdir: dirA, task_id: "a/b" }, 400, "invalid_request", "bad task_id");
  await bad({ prompt: "x", workdir: dirA, model: "bad model!" }, 400, "invalid_request", "bad model");
  await bad({ prompt: "x", workdir: dirA, max_steps: 0 }, 400, "invalid_request", "max_steps 0");
  await bad({ prompt: "x", workdir: dirA, timeout_ms: 5 }, 400, "invalid_request", "timeout too small");
  await bad({ prompt: "x", workdir: dirA, mcp: ["ghost"] }, 400, "unknown_mcp_server", "unknown MCP server");
  await bad({ prompt: "x", workdir: dirA, callback: { url: "ftp://x" } }, 400, "invalid_request", "bad callback url");
  await bad({ prompt: "x", workdir: dirA, env: { "bad-name": "1" } }, 400, "invalid_request", "bad env name");
  await bad({ prompt: "x", workdir: dirA, gateway: { url: "http://example.com" } }, 400, "invalid_gateway", "gateway host not allowed");
  await bad({ prompt: "x", workdir: dirA, builtin_tools: ["ls", "rm_rf"] }, 400, "invalid_request", "unknown built-in tool");
  await bad({ prompt: "x", workdir: dirA, builtin_tools: "ls" }, 400, "invalid_request", "builtin_tools not an array");
  const badJson = await fetch(`${h.base}/v1/tasks`, { method: "POST", headers: { Authorization: `Bearer ${h.key}`, "Content-Type": "application/json" }, body: "{nope" });
  assert(badJson.status === 400 && (await badJson.json()).error.code === "invalid_json", "invalid JSON body");

  // ============================================================ lifecycle
  const created = await post({ task_id: "life-1", prompt: `${tool("ls", { path: "." })} [[say listing done]]`, context: { ticket: "WS-42" } });
  assert(created.status === 202 && created.body.deduplicated === false, "submit -> 202");
  assert(created.headers.get("location") === "/v1/tasks/life-1", "Location header");
  const t0 = created.body.task;
  assert(t0.id === "life-1" && /^ses_[0-9a-f]{16}$/.test(t0.session_id) && t0.session_created === true, "task id + generated session id");
  assert(t0.workdir === dirA && t0.cache === "1h" && t0.model === "claude-sonnet-5-5" && t0.workdir_lock === false, "record echoes workdir/cache/model/lock");
  assert(t0.effort === "high", "record echoes the default effort");
  assert(JSON.stringify(t0.context) === '{"ticket":"WS-42"}', "context echoed untouched");

  const done = await h.waitTask("life-1");
  assert(done.status === "completed" && done.result.text === "listing done", "completed with the final text");
  assert(done.result.steps === 2 && done.result.tool_calls === 1, "2 steps, 1 tool call");
  assert(done.result.usage.input_tokens > 0 && done.result.context_tokens > 0 && done.result.context_window === 1_000_000, "usage + context size reported");
  assert(typeof done.result.context_percent === "number" && done.result.duration_ms >= 0, "context percent + duration");
  assert(done.started_at && done.finished_at && done.progress.last_event_seq > 5, "timestamps + progress");

  const ev = await h.events("life-1");
  assert(ev.every((e: any, i: number) => e.seq === i + 1), "event seq is gap-free from 1");
  assert(ev.every((e: any) => e.task_id === "life-1" && e.session_id === t0.session_id), "every event carries task_id and session_id");
  assert(types(ev)[0] === "task.queued" && types(ev)[1] === "task.started" && types(ev).at(-1) === "task.completed", "queued -> started -> … -> completed");
  const started = ev.find((e: any) => e.type === "task.started").data;
  assert(started.workdir === dirA && started.model === "claude-sonnet-5-5" && started.cache === "1h", "task.started data");
  assert(started.effort === "high", "task.started carries the effort");
  const stepReq = ev.find((e: any) => e.type === "step.request");
  assert(stepReq && stepReq.data.model === "claude-sonnet-5-5" && stepReq.data.effort === "high" && Number(stepReq.data.tools) > 0 && Number(stepReq.data.messages) > 0, "step.request carries the outgoing request facts");
  const tStart = ev.find((e: any) => e.type === "tool.started");
  const tEnd = ev.find((e: any) => e.type === "tool.finished");
  assert(tStart.data.name === "ls" && tStart.data.input.path === "." && tEnd.data.tool_call_id === tStart.data.tool_call_id, "tool.started / tool.finished pair");
  assert(tEnd.data.ok === true && tEnd.data.output.entries.some((x: any) => x.name === "hello.txt"), "tool output visible, ran in the workdir");
  assert(types(ev).includes("step.started") && types(ev).includes("step.finished") && types(ev).includes("agent.text"), "step + text events");
  assert(ev.find((e: any) => e.type === "agent.text").data.text.includes("listing done"), "agent.text carries the answer");
  assert(ev.find((e: any) => e.type === "step.finished").data.usage.input_tokens > 0, "step.finished carries usage");
  assert(ev.find((e: any) => e.type === "task.queued").data.waiting_for === null, "idle server: waiting_for null");

  const list = (await h.api("GET", "/v1/tasks?status=completed")).body;
  assert(list.tasks.some((t: any) => t.id === "life-1") && !(await h.api("GET", "/v1/tasks?status=running")).body.tasks.some((t: any) => t.id === "life-1"), "list + status filter");
  assert((await h.api("GET", "/v1/tasks?status=bogus")).status === 400, "bad status filter -> 400");
  assert((await h.api("GET", `/v1/tasks?session_id=${t0.session_id}`)).body.tasks.length === 1, "session filter");
  assert((await h.api("GET", "/v1/tasks/ghost")).body.error.code === "task_not_found", "unknown task -> 404 envelope");

  // idempotency
  const again = await post({ task_id: "life-1", prompt: `${tool("ls", { path: "." })} [[say listing done]]` });
  assert(again.status === 200 && again.body.deduplicated === true && again.body.task.status === "completed", "same task_id -> deduplicated, no second run");
  assert(fake.turns().length === 2, "dedup did not call the model again");
  const conflict = await post({ task_id: "life-1", prompt: "something else" });
  assert(conflict.status === 409 && conflict.body.error.code === "task_id_conflict", "same task_id, other prompt -> 409");

  // ============================================================ builtin_tools allowlist
  assert(Array.isArray(info.features) && info.features.includes("builtin_tools"), "info advertises builtin_tools");
  const nB = fake.turns().length;
  const bt = (await post({ task_id: "bt-1", builtin_tools: ["ls", "ls"], prompt: `${tool("bash", { command: "echo hi" })} [[say restricted]]`, wait: true })).body.task;
  assert(bt.status === "completed" && JSON.stringify(bt.builtin_tools) === '["ls"]', "allowlist persisted (deduped)");
  const btTools = fake.turns().slice(nB).map((t) => (t.body.tools ?? []).map((x: any) => x.name));
  assert(btTools.length > 0 && btTools.every((names) => names.join() === "ls"), `model sees only the allowed built-ins (got ${JSON.stringify(btTools[0])})`);
  const btEv = await h.events("bt-1");
  const btBash = btEv.find((e: any) => e.type === "tool.failed" && e.data.name === "bash");
  assert(btBash && /unknown tool/.test(btBash.data.error) && !fs.existsSync(path.join(dirA, "hi")), "a disallowed built-in is refused, not run");

  // ============================================================ wait / stream / replay / long-poll
  const waited = await post({ prompt: "[[say waited]]", wait: true });
  assert(waited.status === 200 && waited.body.task.status === "completed" && waited.body.task.result.text === "waited", "wait:true returns the finished task");

  const streamRes = await fetch(`${h.base}/v1/tasks`, {
    method: "POST",
    headers: { Authorization: `Bearer ${h.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ workdir: dirA, prompt: "[[say streamed]]", stream: true }),
  });
  assert(streamRes.headers.get("content-type")!.includes("text/event-stream"), "stream:true -> SSE");
  const sse = parseSse(await streamRes.text());
  assert(sse[0]!.event === "task.queued" && sse.at(-2)!.event === "task.completed" && sse.at(-1)!.event === "end", "SSE: queued … completed, then end");
  assert(sse.at(-1)!.data.status === "completed" && sse.slice(0, -1).every((e, i) => e.id === String(i + 1)), "SSE: ids are the event seqs");

  const taskId = sse[0]!.data.task_id;
  const replay = await fetch(`${h.base}/v1/tasks/${taskId}/events`, { headers: { Authorization: `Bearer ${h.key}`, Accept: "text/event-stream", "Last-Event-ID": "3" } });
  const rs = parseSse(await replay.text());
  assert(rs[0]!.id === "4" && rs.at(-1)!.event === "end", "SSE replay resumes after Last-Event-ID");
  const replay2 = parseSse(await (await fetch(`${h.base}/v1/tasks/${taskId}/events?stream=1&after=100`, { headers: { Authorization: `Bearer ${h.key}` } })).text());
  assert(replay2.length === 1 && replay2[0]!.event === "end", "nothing after the last seq -> just end");

  const slow = (await post({ task_id: "slow-1", prompt: "[[delay 500]] [[say slow]]" })).body.task;
  await sleep(100);
  const cur = (await h.api("GET", "/v1/tasks/slow-1/events?limit=1000")).body;
  const t1 = Date.now();
  const lp = (await h.api("GET", `/v1/tasks/slow-1/events?after=${cur.next_after}&wait_ms=5000`)).body;
  assert(lp.events.length > 0 && Date.now() - t1 < 4000, `long-poll returns as soon as events arrive (${Date.now() - t1} ms)`);
  assert(slow.id === "slow-1" && (await h.waitTask("slow-1")).status === "completed", "long-poll task finishes");

  // ============================================================ session continuity + prompt cache
  const S = "cache-session";
  const n0 = fake.turns().length;
  const c1 = (await post({ task_id: "c1", session_id: S, prompt: "[[say first answer]]", wait: true })).body.task;
  const c2 = (await post({ task_id: "c2", session_id: S, prompt: "[[say second answer]]", wait: true })).body.task;
  assert(c1.session_id === S && c2.session_id === S && c1.session_created === true && c2.session_created === false, "caller-chosen session id; second task continues it");
  const [r1, r2] = fake.turns().slice(n0);
  assert(r1 && r2, "two model requests captured");
  const m1 = r1!.body.messages, m2 = r2!.body.messages;
  assert(m2.length === m1.length + 2, "second request = first request + assistant answer + new user message");
  assert(JSON.stringify(stripCc(m2.slice(0, m1.length))) === JSON.stringify(stripCc(m1)), "PREFIX STABLE: earlier messages are byte-identical (cache can hit)");
  assert(JSON.stringify(stripCc(m2[m1.length])).includes("first answer"), "the previous answer is part of the history");
  assert(JSON.stringify(r2!.body.system) === JSON.stringify(r1!.body.system), "system prompt identical across tasks of a session");
  assert(JSON.stringify(r2!.body.tools) === JSON.stringify(r1!.body.tools), "tool definitions identical across tasks of a session");
  const sysText = JSON.stringify(r1!.body.system);
  assert(!sysText.includes("task_id: c1") && !sysText.includes("working_directory") && !sysText.includes(dirA.replace(/\\/g, "\\\\")), "system prompt carries no task id and no path");
  assert(JSON.stringify(m1[0]).includes("task_id: c1") && JSON.stringify(m1[0]).includes(`working_directory: ${dirA.replace(/\\/g, "\\\\")}`), "task id + workdir travel in the user message");
  const sysLast = r1!.body.system.at(-1);
  assert(sysLast.cache_control?.type === "ephemeral" && sysLast.cache_control.ttl === "1h", "cache breakpoint 1: last system block, ttl 1h");
  const lastBlock = m1.at(-1).content.at(-1);
  assert(lastBlock.cache_control?.type === "ephemeral" && lastBlock.cache_control.ttl === "1h", "cache breakpoint 2: last block of the last message");
  const countCc = (o: unknown): number => (JSON.stringify(o).match(/cache_control/g) ?? []).length;
  assert(countCc(r2!.body) === 2, "exactly 2 breakpoints (limit is 4)");

  // A session's prompt-cache mode is locked by its first turn (Anthropic
  // requires consistent TTL ordering across the whole cached prefix — see
  // compaction.ts's isCacheOrderingError); a later task's own `cache`
  // request is overridden by the session's locked mode, not honored.
  // Session S's first turn (c1, above) used no explicit `cache` -> the
  // server default ("1h") got locked in.
  const off = (await post({ session_id: S, prompt: "[[say x]]", cache: "off", wait: true })).body.task;
  assert(countCc(fake.turns().at(-1)!.body) === 2 && off.cache === "1h", 'cache:"off" is overridden by the session\'s locked "1h" mode');
  await post({ session_id: S, prompt: "[[say y]]", cache: "5m", wait: true });
  const five = fake.turns().at(-1)!.body;
  assert(countCc(five) === 2 && JSON.stringify(five).includes('"ttl":"1h"'), 'cache:"5m" is also overridden — still ttl=1h, not the unmarked 5m lifetime');

  const sess = (await h.api("GET", `/v1/sessions/${S}`)).body;
  assert(sess.session.turns === 4 && sess.session.workdir === dirA && sess.session.title === "[[say first answer]]", "session meta: turns, workdir, title");
  assert(sess.session.context_tokens > 0 && sess.session.compactions === 0 && sess.in_use === false, "session meta: context tokens measured, not in use");
  assert(sess.session.cache_mode === "1h", "session meta exposes the locked cache_mode");

  // A DIFFERENT session's first turn locks in whatever IT started with —
  // confirming the lock is per-session, not some other direction-specific
  // special case (5m -> 1h is overridden exactly like 1h -> off/5m above).
  const S2 = "cache-session-5m";
  const first5m = (await post({ session_id: S2, prompt: "[[say a]]", cache: "5m", wait: true })).body.task;
  assert(first5m.cache === "5m", "a session's first turn uses the cache mode it asked for");
  const overriddenTo1h = (await post({ session_id: S2, prompt: "[[say b]]", cache: "1h", wait: true })).body.task;
  assert(overriddenTo1h.cache === "5m", "a later task asking for 1h is overridden by the session's locked 5m");
  assert(!JSON.stringify(fake.turns().at(-1)!.body).includes('"ttl"'), "the request actually sent still has no ttl field (5m, not 1h)");
  const pg = (await h.api("GET", `/v1/sessions/${S}/messages?offset=0&limit=2`)).body;
  assert(pg.messages.length === 2 && pg.total === sess.session.message_count, "messages endpoint paginates");

  // A cache-ordering 400 (inconsistent TTLs in the cached prefix) is
  // classified and recovered from exactly like context_overflow: the task
  // fails with a dedicated code and the session is flagged for compaction
  // so the next task on it compacts first (compactIfNeeded's
  // "flagged_after_overflow" reason).
  const S3 = "cache-ordering-session";
  const badCache = (
    await post({
      session_id: S3,
      prompt: "[[fail 400 a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block]]",
      wait: true,
    })
  ).body.task;
  assert(
    badCache.status === "failed" && badCache.error?.code === "cache_ordering_error",
    `a cache-ordering 400 is classified as cache_ordering_error (status=${badCache.status}, code=${badCache.error?.code})`,
  );
  assert(
    badCache.result && typeof badCache.result.context_tokens === "number" && badCache.result.context_window > 0,
    "a failed task still reports context_tokens/context_window — not just the error message — so a caller can tell how close it got",
  );
  const s3meta = (await h.api("GET", `/v1/sessions/${S3}`)).body.session;
  assert(s3meta.needs_compaction === true, "the session is flagged for compaction after a cache-ordering failure");

  // continuing after a server restart (new process state, same data directory)
  const home = h.home;
  await h.close();
  const h2 = await startHarness({ home, fake });
  const before = fake.turns().length;
  const after = (await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: S, prompt: "[[say after restart]]", wait: true })).body.task;
  assert(after.status === "completed" && after.session_created === false, "session continues after a restart");
  const rr = fake.turns()[before]!.body.messages;
  assert(rr.length > m2.length, "restarted server sends the stored history, then the new message");
  assert(JSON.stringify(rr).includes("first answer") && JSON.stringify(rr).includes("second answer"), "history survived the restart (messages.jsonl)");
  assert((await h2.api("GET", `/v1/tasks/life-1`)).body.task.status === "completed", "finished tasks survive the restart");
  assert((await h2.events("life-1")).length === ev.length, "event log survives the restart");

  // ============================================================ model passthrough
  await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say m]]", model: "claude-opus-5-5", wait: true });
  assert(fake.turns().at(-1)!.body.model === "claude-opus-5-5", "task.model is what the API receives");
  await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say m]]", wait: true });
  assert(fake.turns().at(-1)!.body.model === "claude-sonnet-5-5", "default model otherwise");

  // ============================================================ effort passthrough
  assert(fake.turns().at(-1)!.body.output_config?.effort === "high", "default effort is sent (high)");
  await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say e]]", effort: "low", wait: true });
  assert(fake.turns().at(-1)!.body.output_config?.effort === "low", 'effort:"low" reaches the request body');
  const effOff = (await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say e]]", effort: "off", wait: true })).body.task;
  assert(fake.turns().at(-1)!.body.output_config?.effort === undefined && effOff.effort === "off", 'effort:"off" omits the field');
  const effOld = (await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say e]]", model: "claude-3-opus-20240229", wait: true })).body.task;
  assert(fake.turns().at(-1)!.body.output_config?.effort === undefined && effOld.effort === "high", "a pre-effort model never receives the field (setting kept)");

  // ============================================================ gateway tool shadowing
  {
    const gw = (shadow?: boolean) => ({
      url: "http://127.0.0.1:9",
      tools: [
        { name: "read", description: "orchestrator read", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "plan", description: "planning helper", input_schema: { type: "object", properties: {} } },
      ],
      ...(shadow === false ? { shadow_builtins: false } : {}),
    });
    const t1 = (await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say s]]", gateway: gw(), wait: true })).body.task;
    const ev1 = (await h2.api("GET", `/v1/tasks/${t1.id}/events?limit=100`)).body.events.find((e: any) => e.type === "tools.loaded");
    const tools1 = fake.turns().at(-1)!.body.tools.map((t: any) => t.name);
    assert(ev1?.data?.shadowed?.join(",") === "read", "wstack_read shadows the local read (tools.loaded event)");
    assert(tools1.includes("wstack_read") && !tools1.includes("read") && tools1.includes("wstack_plan"), "the model sees wstack_read but not the shadowed local read");
    assert(t1.gateway?.shadowed_builtins?.[0] === "read", "the task record remembers the shadowing");

    await h2.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say s2]]", gateway: gw(false), wait: true });
    const tools2 = fake.turns().at(-1)!.body.tools.map((t: any) => t.name);
    assert(tools2.includes("wstack_read") && tools2.includes("read"), "shadow_builtins:false keeps both variants");
  }

  // ============================================================ report_progress + todos
  const rp = (await h2.api("POST", "/v1/tasks", {
    workdir: dirA,
    wait: true,
    prompt: `${tool("report_progress", { message: "halfway there", percent: 50, phase: "implementing" })} ${tool("todo_write", { todos: [{ content: "step one", status: "in_progress" }, { content: "step two", status: "pending" }] })}`,
  })).body.task;
  const rev = await h2.events(rp.id);
  const rep = rev.find((e: any) => e.type === "agent.report");
  assert(rep && rep.data.message === "halfway there" && rep.data.percent === 50 && rep.data.phase === "implementing", "agent.report event");
  assert(!rev.some((e: any) => e.type === "tool.started" && e.data.name === "report_progress"), "report_progress is not duplicated as a tool event");
  assert(rev.find((e: any) => e.type === "agent.todos").data.todos.length === 2, "agent.todos event");
  assert(rp.progress.last_report.message === "halfway there" && rp.progress.todos.length === 2, "progress snapshot holds the last report and todos");
  assert(rp.progress.tool_calls === 2, "report_progress still counts as a tool call");

  // ============================================================ max_steps / API failure
  const ms = (await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: "ms-sess", prompt: tool("ls", { path: "." }), max_steps: 1, wait: true })).body.task;
  assert(ms.status === "failed" && ms.error.code === "max_steps" && ms.result.steps === 1, "step limit -> failed/max_steps with the partial result");
  assert((await h2.api("GET", "/v1/sessions/ms-sess")).body.session.turns === 1, "partial work is committed to the session so the caller can continue");

  const fl = (await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: "fail-sess", prompt: "[[fail 400 this request is broken]]", wait: true })).body.task;
  assert(fl.status === "failed" && fl.error.code === "agent_error" && fl.error.message.includes("this request is broken"), "API error -> failed/agent_error with the API's message");
  assert((await h2.api("GET", "/v1/sessions/fail-sess")).body.session.turns === 0, "a failed task leaves the session untouched");

  // ============================================================ sessions API
  assert((await h2.api("POST", "/v1/sessions", { id: "custom-1" })).status === 201, "create session with a chosen id");
  assert((await h2.api("POST", "/v1/sessions", { id: "custom-1" })).status === 409, "creating it twice -> 409");
  assert((await h2.api("POST", "/v1/sessions", { id: "bad id" })).status === 400, "invalid session id -> 400");
  assert((await h2.api("GET", "/v1/sessions/ghost")).body.error.code === "session_not_found", "unknown session -> 404");
  const gen = (await h2.api("POST", "/v1/sessions", {})).body.session;
  assert(/^ses_/.test(gen.id), "session id generated when omitted");
  const cp = (await h2.api("POST", "/v1/sessions/custom-1/compact", {})).body;
  assert(cp.compacted === false && cp.turns_summarized === 0, "compacting a tiny session is a no-op");
  assert((await h2.api("POST", "/v1/sessions/ghost/compact", {})).status === 404, "compact unknown -> 404");
  await h2.api("POST", "/v1/tasks", { workdir: dirA, session_id: "busy-1", prompt: "[[delay 600]] [[say b]]" });
  await sleep(100);
  assert((await h2.api("DELETE", "/v1/sessions/busy-1")).status === 409, "deleting a busy session -> 409");
  assert((await h2.api("POST", "/v1/sessions/busy-1/compact", {})).status === 409, "compacting a busy session -> 409");
  assert((await h2.api("GET", "/v1/sessions/busy-1")).body.in_use === true, "in_use flag");
  await h2.waitTask((await h2.api("GET", "/v1/tasks?session_id=busy-1")).body.tasks[0].id);
  assert((await h2.api("DELETE", "/v1/sessions/busy-1")).status === 200 && (await h2.api("GET", "/v1/sessions/busy-1")).status === 404, "delete after it finished");

  // ============================================================ crash recovery (seeded)
  await h2.close();
  const home3 = path.join(home, "recovery");
  const seed = new TaskStore(path.join(home3, "tasks"));
  const now = new Date().toISOString();
  seed.put({
    id: "crashed-1", status: "running", session_id: "s-crash", session_created: true, prompt: "p", model: "m", max_steps: 5, timeout_ms: 5000,
    cache: "1h", workdir: dirA, workdir_lock: false, env_keys: [], created_at: now, started_at: now,
    progress: { last_event_seq: 3, steps: 1, tool_calls: 0, last_activity_at: now },
  });
  for (const [i, type] of ["task.queued", "task.started", "step.started"].entries()) {
    seed.appendEvent({ seq: i + 1, ts: now, task_id: "crashed-1", session_id: "s-crash", type: type as never, data: {} });
  }
  const h3 = await startHarness({ home: home3, fake });
  const crashed = (await h3.api("GET", "/v1/tasks/crashed-1")).body.task;
  assert(crashed.status === "failed" && crashed.error.code === "server_restarted", "leftover running task -> failed/server_restarted");
  const cev = await h3.events("crashed-1");
  assert(cev.length === 4 && cev[3].seq === 4 && cev[3].type === "task.failed" && cev[3].data.error.code === "server_restarted", "terminal event continues the seq after the crash");

  // ============================================================ MCP config endpoints
  {
    const fixture = path.join(import.meta.dirname ?? ".", "fixtures", "mini-mcp.mjs");
    const put = await h3.api("PUT", "/v1/mcp/servers/mini?test=1", { command: process.execPath, args: [fixture, "stdio"] });
    assert([200, 201].includes(put.status) && put.body.server, "mcp PUT + test");
    const list = await h3.api("GET", "/v1/mcp/servers");
    assert(list.status === 200 && list.body.servers.some((x: any) => x.name === "mini"), "mcp GET list");
    const imp = await h3.api("POST", "/v1/mcp/import", { mcpServers: { imp1: { command: "node" } }, overwrite: false });
    assert(imp.status === 200 && imp.body.added.includes("imp1"), "mcp POST import");
    const tools = await h3.api("GET", "/v1/mcp/servers/mini/tools");
    assert(tools.status === 200 && tools.body.tools.length > 0, "mcp GET tools");
    const one = await h3.api("GET", "/v1/mcp/servers/mini/tools?tool=echo");
    assert(one.status === 200 && one.body.tool.name === "echo", "mcp GET tools?tool=");
    const miss = await h3.api("GET", "/v1/mcp/servers/mini/tools?tool=nope");
    assert(miss.status === 404, "mcp GET tools?tool= missing 404");
    const tst = await h3.api("POST", "/v1/mcp/servers/mini/test");
    assert(tst.status === 200 && tst.body.ok, "mcp POST test");
    const en = await h3.api("POST", "/v1/mcp/servers/imp1/enable");
    assert(en.status === 200, "mcp POST enable");
    const dis = await h3.api("POST", "/v1/mcp/servers/imp1/disable");
    assert(dis.status === 200, "mcp POST disable");
    const del = await h3.api("DELETE", "/v1/mcp/servers/imp1");
    assert(del.status === 200, "mcp DELETE");
    const delMiss = await h3.api("DELETE", "/v1/mcp/servers/ghost");
    assert(delMiss.status === 404, "mcp DELETE unknown 404");
  }

  // ============================================================ maintenance endpoint
  const old = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const mk = (id: string, finishedDaysAgo: number) => {
    h3.app.taskStore.put({
      id, status: "completed", session_id: "s-old", session_created: false, prompt: "p", model: "m", max_steps: 5, timeout_ms: 5000, cache: "1h",
      workdir: dirA, workdir_lock: false, env_keys: [], created_at: old(finishedDaysAgo + 1), finished_at: old(finishedDaysAgo),
      progress: { last_event_seq: 1, steps: 0, tool_calls: 0, last_activity_at: old(finishedDaysAgo) },
    });
    h3.app.taskStore.appendEvent({ seq: 1, ts: old(finishedDaysAgo), task_id: id, session_id: "s-old", type: "task.completed", data: { marker: id } });
  };
  mk("ancient-1", 200); // beyond the 90-day retention
  mk("middle-1", 10); // beyond the 3-day compression age
  mk("fresh-1", 0);
  const mnt = await h3.api("POST", "/v1/maintenance/run");
  assert(mnt.status === 200 && mnt.body.tasks.deleted.includes("ancient-1") && mnt.body.tasks.compressed.includes("middle-1"), "maintenance: old task deleted, middle one compressed");
  assert((await h3.api("GET", "/v1/tasks/ancient-1")).status === 404, "deleted task is gone");
  const comp = await h3.events("middle-1");
  assert(comp.length === 1 && comp[0].data.marker === "middle-1", "compressed event log is still readable through the API");
  assert(fs.existsSync(path.join(home3, "tasks", "middle-1", "events.jsonl.gz")) && !fs.existsSync(path.join(home3, "tasks", "middle-1", "events.jsonl")), "events.jsonl became events.jsonl.gz");
  assert(!mnt.body.tasks.compressed.includes("fresh-1") && !mnt.body.tasks.deleted.includes("fresh-1"), "fresh task untouched");
  void gzipFile;

  // ============================================================ dashboard (static shell + ?key= auth)
  {
    const web = path.join(home3, "webui-dist");
    fs.mkdirSync(path.join(web, "assets"), { recursive: true });
    fs.writeFileSync(path.join(web, "index.html"), '<!doctype html><html><body>wf-dashboard-shell</body></html>');
    fs.writeFileSync(path.join(web, "assets", "app.js"), "console.log('wf-asset')");
    const h4 = await startHarness({ fake, webuiDir: web });
    try {
      // the shell is public; the data behind it is not
      let r = await fetch(`${h4.base}/`);
      assert(r.status === 200 && (r.headers.get("content-type") ?? "").includes("text/html") && (await r.text()).includes("wf-dashboard-shell"), "dashboard index served without a key");
      r = await fetch(`${h4.base}/assets/app.js`);
      assert(r.status === 200 && (r.headers.get("content-type") ?? "").includes("javascript") && (await r.text()).includes("wf-asset"), "asset served with its mime type");
      r = await fetch(`${h4.base}/deep/client/route`);
      assert(r.status === 200 && (await r.text()).includes("wf-dashboard-shell"), "SPA deep link falls back to index.html");
      r = await fetch(`${h4.base}/..%2f..%2fpackage.json`);
      assert(r.status !== 200 || !(await r.text()).includes("wrongforge"), "traversal outside webuiDir is refused");
      // browsers cannot set headers on EventSource: ?key= must authenticate
      r = await fetch(`${h4.base}/v1/info?key=${h4.key}`);
      assert(r.status === 200 && (await r.json()).default_model, "query-string key authenticates");
      r = await fetch(`${h4.base}/v1/info?key=wrong-key-wrong-key`);
      assert(r.status === 401, "wrong query key is rejected");

      // the global SSE feed also carries live HTTP traffic: every /v1 call
      // (except the stream itself) arrives as an http.request frame
      const ac = new AbortController();
      const sseRes = await fetch(`${h4.base}/v1/events?key=${h4.key}`, { headers: { Accept: "text/event-stream" }, signal: ac.signal });
      assert(sseRes.status === 200 && sseRes.body, "global SSE connects with the query key");
      const sseText = { out: "" };
      const reading = (async () => {
        const reader = sseRes.body!.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            sseText.out += dec.decode(value, { stream: true });
          }
        } catch {
          /* aborted — that is the normal end of this check */
        }
      })();
      await sleep(150); // let the stream (and its traffic tap) attach server-side
      await h4.api("GET", "/v1/info");
      let sawHttp = false;
      for (let i = 0; i < 50 && !sawHttp; i++) {
        sawHttp = sseText.out.includes("event: http.request") && sseText.out.includes(`"path":"/v1/info"`);
        if (!sawHttp) await sleep(100);
      }
      assert(sawHttp, "global SSE carries live http.request frames for /v1 calls");
      ac.abort();
      await reading;

      // backlog replay: traffic that happened while no dashboard was connected
      // must appear when one opens late — live-only taps would leave a freshly
      // opened dashboard looking inexplicably empty
      await h4.api("GET", "/v1/tools");
      const ac2 = new AbortController();
      const late = await fetch(`${h4.base}/v1/events?key=${h4.key}`, { headers: { Accept: "text/event-stream" }, signal: ac2.signal });
      const lateText = { out: "" };
      const reading2 = (async () => {
        const reader = late.body!.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            lateText.out += dec.decode(value, { stream: true });
          }
        } catch {
          /* aborted — that is the normal end of this check */
        }
      })();
      let sawReplay = false;
      for (let i = 0; i < 50 && !sawReplay; i++) {
        sawReplay = lateText.out.includes("event: http.request") && lateText.out.includes(`"path":"/v1/tools"`);
        if (!sawReplay) await sleep(100);
      }
      assert(sawReplay, "late-joining SSE subscriber gets the recent-traffic backlog replayed");
      ac2.abort();
      await reading2;

      // task events replay too — from disk, so a dashboard opened after a
      // serve restart still sees the rounds/tool calls that already ran
      const done2 = await h4.api("POST", "/v1/tasks", { workdir: dirA, prompt: "[[say replay me]]", wait: true });
      assert(done2.body.task.status === "completed", "replay-probe task completed");
      const ac3 = new AbortController();
      const late2 = await fetch(`${h4.base}/v1/events?key=${h4.key}`, { headers: { Accept: "text/event-stream" }, signal: ac3.signal });
      const late2Text = { out: "" };
      const reading3 = (async () => {
        const reader = late2.body!.getReader();
        const dec = new TextDecoder();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            late2Text.out += dec.decode(value, { stream: true });
          }
        } catch {
          /* aborted */
        }
      })();
      let sawEventReplay = false;
      for (let i = 0; i < 50 && !sawEventReplay; i++) {
        sawEventReplay = late2Text.out.includes("event: task.completed") && late2Text.out.includes("replay me");
        if (!sawEventReplay) await sleep(100);
      }
      assert(sawEventReplay, "the global feed replays recent task events from disk, not just http traffic");
      ac3.abort();
      await reading3;
    } finally {
      await h4.close();
    }
    // and when nothing is built, / explains how to build instead of a bare 404
    const empty = path.join(home3, "webui-empty");
    fs.mkdirSync(empty, { recursive: true });
    const h5 = await startHarness({ fake, webuiDir: empty });
    try {
      const r = await fetch(`${h5.base}/`);
      assert(r.status === 200 && (await r.text()).includes("webui:build"), "not-built hint page");
    } finally {
      await h5.close();
    }
  }

  // ==================================================== event-log integrity (F101)
  // A failed durable append must never punch a hole in events.jsonl: `seq` is
  // documented as strictly increasing and gap-free, and every seq handed to a
  // live subscriber or a webhook must stay replayable from the log.
  {
    const h6 = await startHarness({ fake });
    try {
      const d6 = h6.mkdir("seqgap");
      const store = h6.app.taskStore as unknown as { appendEvent: (ev: unknown) => void };
      const append = store.appendEvent.bind(store);
      const seen: number[] = [];
      h6.app.manager.subscribe((ev: { seq: number }) => seen.push(ev.seq));
      let armed = false;
      store.appendEvent = (ev: unknown) => {
        if (!armed && (ev as { type: string }).type === "step.started") {
          armed = true;
          throw new Error("injected: ENOSPC (no space left on device)");
        }
        return append(ev);
      };
      const t6 = (await h6.api("POST", "/v1/tasks", { workdir: d6, prompt: `${tool("ls", { path: "." })} [[say gap]]` })).body.task;
      const done6 = await h6.waitTask(t6.id);
      await sleep(250);
      assert(armed, "the injected append failure was actually reached");
      assert(done6.status === "completed", `the task still completes when one append fails (${done6.status})`);
      const logged = ((await h6.events(t6.id)) as { seq: number }[]).map((e) => e.seq);
      assert(logged.length > 5, `the task produced a real event log (${logged.length} events)`);
      assert(logged[0] === 1 && logged.every((s, i) => i === 0 || s === logged[i - 1]! + 1), `events.jsonl stays gap-free from 1 after a failed append: ${logged.join(",")}`);
      assert(seen.every((s) => logged.includes(s)), "no seq reaches a subscriber that the log could never replay");
      assert(done6.progress.last_event_seq === logged.length, `progress.last_event_seq matches the log (${done6.progress.last_event_seq} vs ${logged.length})`);
    } finally {
      await h6.close();
    }
  }

  // ==================================================== terminal-event delivery (F103)
  // The TERMINAL event (task.completed/failed/cancelled/timed_out) is a task's
  // last word: unlike an intermediate event, no later event can ever heal a
  // dropped one. A ONE-OFF transient append failure on it (the realistic
  // trigger: a brief antivirus/indexer file lock) must not permanently
  // silence the task for its subscribers and webhook.
  {
    const h7 = await startHarness({ fake });
    try {
      const d7 = h7.mkdir("termevt");
      const store = h7.app.taskStore as unknown as { appendEvent: (ev: unknown) => void };
      const append = store.appendEvent.bind(store);
      const seenTypes: string[] = [];
      h7.app.manager.subscribe((ev: { type: string }) => seenTypes.push(ev.type));
      const rcv = await startReceiver((_r, res) => void res.writeHead(200).end("ok"));
      let thrown = 0;
      store.appendEvent = (ev: unknown) => {
        if ((ev as { type: string }).type === "task.completed" && thrown < 1) {
          thrown++;
          throw new Error("injected: EBUSY (transient, the very next attempt succeeds)");
        }
        return append(ev);
      };
      const t7 = (await h7.api("POST", "/v1/tasks", {
        workdir: d7,
        prompt: `${tool("ls", { path: "." })} [[say later]]`,
        callback: { url: rcv.url, events: ["*"] },
      })).body.task;
      const done7 = await h7.waitTask(t7.id);
      await sleep(250);
      await h7.app.webhook.idle();
      assert(thrown === 1, "the injected transient failure was actually reached exactly once");
      assert(done7.status === "completed", `the task still completes (${done7.status})`);
      assert(seenTypes.includes("task.completed"), "a one-off transient failure on the terminal event must not silence the live subscriber feed");
      assert(rcv.received.some((r) => r.json?.type === "task.completed"), "the task's webhook must still receive task.completed after one transient hiccup");
      await rcv.close();
    } finally {
      await h7.close();
    }
  }

  // =============================================================== image attachments (F2701)
  {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const h4 = await startHarness({ defaultWorkdir: undefined });
    const d = h4.mkdir("imgs");

    // validation: whitelist + base64 + size + count
    const badType = await h4.api("POST", "/v1/tasks", { workdir: d, prompt: "x", images: [{ media_type: "image/bmp", data: png }] });
    assert(badType.status === 400 && /media_type/.test(badType.body.error.message), "unsupported media type -> 400");
    const badB64 = await h4.api("POST", "/v1/tasks", { workdir: d, prompt: "x", images: [{ media_type: "image/png", data: "not@base64!" }] });
    assert(badB64.status === 400 && /base64/.test(badB64.body.error.message), "invalid base64 -> 400");
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5 * 1024 * 1024)]);
    const tooBig = await h4.api("POST", "/v1/tasks", { workdir: d, prompt: "x", images: [{ media_type: "image/png", data: big.toString("base64") }] });
    assert(tooBig.status === 400 && /5 MB/.test(tooBig.body.error.message), "over 5 MB -> 400 with the limit named");
    const six = await h4.api("POST", "/v1/tasks", { workdir: d, prompt: "x", images: Array.from({ length: 6 }, () => ({ media_type: "image/png", data: png })) });
    assert(six.status === 400 && /at most 5/.test(six.body.error.message), "6 images -> 400");

    // the happy path: bytes land as task-dir files; the request carries image blocks
    const seen: any[] = [];
    h4.fake.script = (ctx: any) => {
      seen.push(ctx.body);
      return { kind: "text", text: "saw the image", usage: { input: 50, output: 5 } };
    };
    const tRes = await h4.api("POST", "/v1/tasks", { workdir: d, prompt: "[[say what-is-this]]", images: [{ media_type: "image/png", data: png }] });
    assert(tRes.status === 202, `image submit -> 202 (got ${tRes.status})`);
    const t = tRes.body.task;
    assert(t.images?.[0]?.file === "images/00.png" && t.images?.[0]?.media_type === "image/png", "the record carries image metadata refs (no base64)");
    assert(fs.existsSync(path.join(h4.home, "tasks", t.id, "images", "00.png")), "the decoded bytes are stored in the task dir");
    let done: any = { status: "timeout" };
    for (let i = 0; i < 200; i++) {
      const r = await h4.api("GET", `/v1/tasks/${t.id}`);
      if (["completed", "failed", "cancelled", "timed_out"].includes(r.body.task?.status)) {
        done = r.body.task;
        break;
      }
      await sleep(50);
    }
    assert(done.status === "completed", "the image task completes");
    const wire = seen.find((b) => Array.isArray(b?.messages) && b.messages.length > 0);
    const firstBlock = wire?.messages?.[0]?.content?.[0];
    assert(firstBlock?.type === "image" && firstBlock.source?.data === png, "the first user message carries the image as an API block");
    const taskJson = fs.readFileSync(path.join(h4.home, "tasks", t.id, "task.json"), "utf8");
    assert(!taskJson.includes(png), "task.json does not embed the base64");
    // validation happens before session creation: a rejected submit leaves no session
    const cnt0 = (await h4.api("GET", "/v1/sessions")).body.sessions.length;
    await h4.api("POST", "/v1/tasks", { workdir: d, prompt: "x", images: [{ media_type: "image/bmp", data: png }] });
    const cnt1 = (await h4.api("GET", "/v1/sessions")).body.sessions.length;
    assert(cnt0 === cnt1, "a rejected image submit creates no session");

    await h4.close();
  }

  await h3.close();
  await fake.close();
  console.log("TASKS CORE TESTS PASSED ✓ (auth, validation, lifecycle, events, idempotency, wait/stream/replay/long-poll, sessions, cache prefix stability, restart continuity, recovery, maintenance, dashboard, event-log integrity, terminal-event delivery)");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
