/**
 * Multiple orchestrators share one WrongForge server: named client keys
 * (AGENT_API_KEYS / api-keys.json) give each of them their own identity.
 * Tasks are stamped with the authenticated client, sessions are owned by
 * their creator (foreign submits are refused — histories never mix), and
 * list/event/cancel routes are scoped to the caller; the single key stays
 * the "default" admin view. Plus the queue's fair-share rule: one client
 * that already holds every slot but the last cannot take that last one
 * while another client has a startable task queued.
 *
 *   npx tsx test/clients.test.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { resolveClientKeys, DEFAULT_CLIENT, CLIENT_NAME_RE } from "../src/apikey.js";
import { assert, sleep, startHarness, type Harness } from "./helpers/harness.js";

const KEY_A = "wf_test_client_a_key_0123456789";
const KEY_B = "wf_test_client_b_key_0123456789";

/** A Harness.api variant that authenticates as a named client. */
function apiAs(h: Harness, key: string) {
  return async (method: string, p: string, body?: unknown): Promise<any> => {
    const res = await fetch(`${h.base}${p}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed };
  };
}

async function main(): Promise<void> {
  // =============================================================== key config (offline)
  {
    const k = resolveClientKeys("wf_default_key_0123456789", { AGENT_API_KEYS: `alpha=${KEY_A},beta=${KEY_B}` });
    assert(k.byKey.get(KEY_A) === "alpha" && k.byKey.get(KEY_B) === "beta" && k.byKey.get("wf_default_key_0123456789") === DEFAULT_CLIENT, "env map resolves name=key pairs plus the default");
    assert(k.source === "env", "source is env");

    for (const [label, env] of [
      ["not name=key", { AGENT_API_KEYS: "alpha" }],
      ["reserved name", { AGENT_API_KEYS: `default=${KEY_A}` }],
      ["short key", { AGENT_API_KEYS: `alpha=short` }],
      ["duplicate key", { AGENT_API_KEYS: `alpha=${KEY_A},beta=${KEY_A}` }],
      ["collides with the default key", { AGENT_API_KEYS: `alpha=wf_default_key_0123456789` }],
      ["bad name", { AGENT_API_KEYS: `a b=${KEY_A}` }],
    ] as const) {
      let threw = false;
      try {
        resolveClientKeys("wf_default_key_0123456789", env);
      } catch {
        threw = true;
      }
      assert(threw, `invalid config fails closed: ${label}`);
    }

    assert(CLIENT_NAME_RE.test("stack-a.2") && !CLIENT_NAME_RE.test("-x") && !CLIENT_NAME_RE.test("x".repeat(33)), "client name pattern");

    // file source: a missing file is fine (source none), a bad one throws
    const dir = fs.mkdtempSync("wf-clients-cfg-");
    const missing = resolveClientKeys("wf_default_key_0123456789", {}, path.join(dir, "nope.json"));
    assert(missing.source === "none" && missing.byKey.size === 1, "missing api-keys.json is not an error");
    fs.writeFileSync(path.join(dir, "api-keys.json"), JSON.stringify({ gamma: KEY_A }));
    const viaFile = resolveClientKeys("wf_default_key_0123456789", {}, path.join(dir, "api-keys.json"));
    assert(viaFile.byKey.get(KEY_A) === "gamma" && viaFile.source === "file", "file map resolves");
    fs.writeFileSync(path.join(dir, "bad.json"), "{ nope");
    let threw = false;
    try {
      resolveClientKeys("wf_default_key_0123456789", {}, path.join(dir, "bad.json"));
    } catch {
      threw = true;
    }
    assert(threw, "malformed api-keys.json fails closed");
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // =============================================================== isolation between two clients
  {
    const h = await startHarness({ clientKeys: new Map([[KEY_A, "stackA"], [KEY_B, "stackB"]]) });
    const apiA = apiAs(h, KEY_A);
    const apiB = apiAs(h, KEY_B);
    const d = h.mkdir("iso");

    const ra = await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[say from A]]" });
    if (!ra.body?.task) throw new Error(`submit A failed: ${ra.status} ${JSON.stringify(ra.body)}`);
    const ta = ra.body.task;
    const rb = await apiB("POST", "/v1/tasks", { workdir: d, prompt: "[[say from B]]" });
    if (!rb.body?.task) throw new Error(`submit B failed: ${rb.status} ${JSON.stringify(rb.body)}`);
    const tb = rb.body.task;
    assert(ta.client === "stackA" && tb.client === "stackB", "tasks are stamped with the authenticated client");
    await h.waitTask(ta.id);
    await h.waitTask(tb.id);

    // session ownership: B cannot continue A's session
    const cross = await apiB("POST", "/v1/tasks", { workdir: d, prompt: "sneak", session_id: ta.session_id });
    assert(cross.status === 403 && cross.body.error.code === "session_not_owned", `foreign session submit -> 403 (got ${cross.status} ${JSON.stringify(cross.body)})`);

    // foreign task surfaces: 404, never content
    assert((await apiB("GET", `/v1/tasks/${ta.id}`)).status === 404, "foreign GET task -> 404");
    assert((await apiB("GET", `/v1/tasks/${ta.id}/events`)).status === 404, "foreign task events -> 404");
    assert((await apiB("POST", `/v1/tasks/${ta.id}/cancel`, {})).status === 404, "foreign cancel -> 404");

    // idempotency does not leak: resubmitting A's task_id as B conflicts without echoing the task
    const dup = await apiB("POST", "/v1/tasks", { task_id: ta.id, workdir: d, prompt: "[[say from A]]" });
    assert(dup.status === 409 && dup.body.error.code === "task_id_conflict" && !dup.body.task, "cross-client task_id resubmit -> 409, no task echoed");

    // list scoping
    const listA = (await apiA("GET", "/v1/tasks?limit=100")).body.tasks.map((t: any) => t.id);
    const listB = (await apiB("GET", "/v1/tasks?limit=100")).body.tasks.map((t: any) => t.id);
    const listAll = (await h.api("GET", "/v1/tasks?limit=100")).body.tasks.map((t: any) => t.id);
    assert(listA.includes(ta.id) && !listA.includes(tb.id), "A sees only A's tasks");
    assert(listB.includes(tb.id) && !listB.includes(ta.id), "B sees only B's tasks");
    assert(listAll.includes(ta.id) && listAll.includes(tb.id), "the default key sees every client");

    // sessions API scoping
    const sessB = (await apiB("GET", "/v1/sessions")).body.sessions.map((s: any) => s.id);
    assert(sessB.includes(tb.session_id) && !sessB.includes(ta.session_id), "B's session list is scoped");
    assert((await apiB("GET", `/v1/sessions/${ta.session_id}`)).status === 403, "foreign session GET -> 403 session_not_owned");
    assert((await apiB("DELETE", `/v1/sessions/${ta.session_id}`)).status === 403, "foreign session DELETE -> 403");
    assert((await apiB("GET", `/v1/sessions/${tb.session_id}`)).status === 200, "own session GET -> 200");
    assert((await h.api("GET", `/v1/sessions/${ta.session_id}`)).status === 200, "default key reads any session");

    // the legacy single key still works alone (implicit default client)
    assert((await h.api("POST", "/v1/tasks", { workdir: d, prompt: "[[say default]]" })).status === 202, "default key submits without a client map");

    // global feed scoping: while A's task runs, B's feed never carries A's events
    const runA = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 1200]] [[say long A]]" })).body.task;
    await sleep(150);
    const res = await fetch(`${h.base}/v1/events`, { headers: { Authorization: `Bearer ${KEY_B}`, Accept: "text/event-stream" } });
    const reader = res.body!.getReader()!;
    let seen = "";
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      const chunk = await Promise.race([reader.read(), sleep(200).then(() => null)]);
      if (!chunk) continue;
      if (chunk.done) break;
      seen += new TextDecoder().decode(chunk.value);
      if (seen.includes(`task_id":"${runA.id}"`)) break;
    }
    reader.cancel().catch(() => undefined);
    await h.waitTask(runA.id);
    assert(!seen.includes(runA.id), "B's global feed never carries A's task events");

    await h.close();
  }

  // =============================================================== fair share: the last slot is shared
  {
    const h = await startHarness({ app: { maxConcurrency: 2 }, clientKeys: new Map([[KEY_A, "stackA"], [KEY_B, "stackB"]]) });
    const apiA = apiAs(h, KEY_A);
    const apiB = apiAs(h, KEY_B);
    const d = h.mkdir("fair");

    // A fills both slots and queues a third; B queues one task
    const a1 = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 1500]] [[say a1]]" })).body.task;
    const a2 = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 1500]] [[say a2]]" })).body.task;
    const a3 = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[say a3]]" })).body.task;
    const b1 = (await apiB("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 300]] [[say b1]]" })).body.task;

    await h.waitTask(b1.id);
    const a3Doc = (await h.api("GET", `/v1/tasks/${a3.id}`)).body.task;
    assert(a3Doc.status !== "running", `A's third task did not take the last slot while B waited (status ${a3Doc.status})`);
    const bDoc = (await h.api("GET", `/v1/tasks/${b1.id}`)).body.task;
    assert(bDoc.started_at, "B's task got the fair slot and ran");
    assert(Date.parse(bDoc.started_at) < Date.parse((await h.api("GET", `/v1/tasks/${a3.id}`)).body.task.started_at ?? "9999"), "B started before A's third task");
    // a3's task.queued already told the truth about the fair block (no
    // contradicting queue_update right after)
    const queued = (await h.events(a3.id)).find((e: any) => e.type === "task.queued");
    const contradicting = (await h.events(a3.id)).some((e: any) => e.type === "task.queue_update" && e.data.waiting_for === null);
    assert(queued.data.waiting_for === "capacity" && !contradicting, `queued event is fair-aware, no null correction follows (queued=${JSON.stringify(queued.data)})`);

    const [ra1, ra2, ra3] = [await h.waitTask(a1.id), await h.waitTask(a2.id), await h.waitTask(a3.id)];
    assert([ra1, ra2, ra3].every((t) => t.status === "completed"), "every task completed once slots freed");
    await h.close();
  }

  // =============================================================== queue-flood guard (per-client cap)
  {
    const h = await startHarness({ app: { maxConcurrency: 1, maxQueuedPerClient: 2 }, clientKeys: new Map([[KEY_A, "stackA"], [KEY_B, "stackB"]]) });
    const apiA = apiAs(h, KEY_A);
    const apiB = apiAs(h, KEY_B);
    const d = h.mkdir("flood");

    // A fills the one slot and queues up to its cap of 2
    const a1 = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 2500]] [[say a1]]" })).body.task;
    const a2 = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 100]] [[say a2]]" })).body.task;
    const a3 = (await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[delay 100]] [[say a3]]" })).body.task;
    const a4 = await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[say a4]]" });
    assert(a4.status === 429 && a4.body.error.code === "queue_full", `4th A submit -> 429 queue_full (got ${a4.status} ${JSON.stringify(a4.body)})`);
    assert(/MAX_QUEUED_PER_CLIENT/.test(a4.body.error.message), "the error names the knob");

    // the cap is per client: B and the default key submit freely while A is capped
    assert((await apiB("POST", "/v1/tasks", { workdir: d, prompt: "[[say b]]" })).status === 202, "another client is unaffected");
    assert((await h.api("POST", "/v1/tasks", { workdir: d, prompt: "[[say default]]" })).status === 202, "the default key is never capped");

    // cancel one queued A task -> room for one more
    await h.api("POST", `/v1/tasks/${a2.id}/cancel`, {});
    assert((await apiA("POST", "/v1/tasks", { workdir: d, prompt: "[[say a5]]" })).status === 202, "after a cancel the client can queue again");

    for (const id of [a1.id, a3.id]) await h.api("POST", `/v1/tasks/${id}/cancel`, {});
    await h.close();
  }

  console.log("CLIENT TESTS PASSED ✓ (key config fail-closed, task stamping, session ownership 403, 404 scoping, no-leak idempotency, list/session scoping, scoped global feed, default-key admin view + backward compat, fair-share last slot, queue-flood cap)");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
