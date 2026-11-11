/**
 * Context management for long sessions.
 *
 * A session's whole history is sent with every request. Three defenses keep
 * it from outgrowing the model's context window:
 *
 *  1. Per-result cap — `truncateToolOutput` (used right after `runTool` in
 *     agent.ts, before a result ever reaches `history`): any single tool
 *     result bigger than `maxToolResultChars` is clipped there and then,
 *     regardless of which tool produced it. Built-in tools (bash/read/
 *     web_fetch/grep) already bound their own output; MCP and gateway tools
 *     do not — this is the backstop for those, and for anything that slips
 *     through. Without it, one oversized result can push a request straight
 *     past the model's context window before anything else in this file
 *     gets a chance to react (see `clearAt` below).
 *
 *  2. In-task guard — `clearOldToolOutputs` (used from the step loop in
 *     agent.ts): when the live context passes `clearAt` tokens, old tool
 *     outputs are replaced by a short placeholder (the model's own text and
 *     tool calls stay). Cheap, no extra model call. Checked both before each
 *     step AND right after a tool result is appended, using a same-turn
 *     character-count estimate of that result (the API's own usage numbers
 *     only arrive with the *next* response, too late to catch a result that
 *     alone jumps past the limit — the estimate exists purely to make this
 *     check fire at the right moment, not to replace the real count).
 *
 *  3. Between tasks — `compactMessages`: older turns are summarized by the
 *     model into one message; the most recent turns stay verbatim. The
 *     originals are archived by the session store, never lost.
 *
 * All three change the request prefix at most once per occurrence, so the
 * prompt cache is rewritten once and then stable again. Reported sizes
 * (`context_tokens` on a finished turn) still come from the API's own usage
 * numbers — the character estimate in #1/#2 only drives *when* a defense
 * reacts, never what gets reported to the caller.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { AgentMessage } from "./messages.js";
import { runInContext } from "./context.js";

export const CLEARED_PLACEHOLDER = "[tool output cleared to save context]";

// ------------------------------------------------------------------- config

export interface ContextConfig {
  /** Model context window in tokens (default 1 000 000). Used for percentages. */
  window: number;
  /** Compact a session before a task when its context exceeds this (0 = never). Default 150 000. */
  compactAt: number;
  /** Clear old tool outputs inside a task when the live context exceeds this (0 = never). Default 600 000. */
  clearAt: number;
  /** Turns (tasks) kept verbatim by a compaction. Default 2. */
  keepTurns: number;
  /** Most recent tool results never cleared by the in-task guard. Default 8. */
  keepToolResults: number;
  /** A single tool result bigger than this (chars, 0 = never) is clipped
   *  before it ever reaches history — see `truncateToolOutput`. Default
   *  400 000 (~100K tokens): generous next to what built-in tools already
   *  self-limit to (tens of thousands of chars), it exists to catch an
   *  oversized MCP/gateway result, not to constrain normal use. */
  maxToolResultChars: number;
  /** Model for the summary (default: the task's model). */
  summaryModel?: string;
}

const num = (v: string | undefined, d: number): number => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export function contextConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ContextConfig {
  return {
    window: num(env.WRONGFORGE_CONTEXT_WINDOW, 1_000_000) || 1_000_000,
    compactAt: num(env.WRONGFORGE_COMPACT_AT, 150_000),
    clearAt: num(env.WRONGFORGE_CLEAR_AT, 600_000),
    keepTurns: Math.max(1, num(env.WRONGFORGE_COMPACT_KEEP_TURNS, 2)),
    keepToolResults: Math.max(1, num(env.WRONGFORGE_KEEP_TOOL_RESULTS, 8)),
    maxToolResultChars: num(env.WRONGFORGE_MAX_TOOL_OUTPUT_CHARS, 400_000),
    summaryModel: env.WRONGFORGE_SUMMARY_MODEL || undefined,
  };
}

/** Rough chars-per-token used only to decide WHEN the in-task guard should
 *  react to a just-appended tool result — never to report a real count (see
 *  the file header). The API's own usage numbers always win on the next
 *  response. */
const CHARS_PER_TOKEN_ESTIMATE = 4;

/** Kept in one place so `agent.ts` and this file agree on the same guess. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

/** Does this provider error mean "the prompt does not fit"? */
export function isContextOverflow(text: string): boolean {
  return /prompt is too long|input is too long|context (length|window)|exceeds? the (maximum|context)|too many (input )?tokens|maximum context/i.test(
    text,
  );
}

/**
 * Does this provider error mean "the cache_control TTLs in this request are
 * ordered inconsistently"? Anthropic requires a consistent TTL ordering
 * across the whole cached prefix (tools -> system -> messages); a later
 * turn using a different `cache` mode than an earlier one on the same
 * session can produce exactly this (cache.ts only ever marks the newest
 * message, never touching older cache_control blocks already in history).
 * Like context overflow, this is recoverable by compacting the session:
 * the offending older blocks get summarized away, not re-sent.
 */
export function isCacheOrderingError(text: string): boolean {
  // Matched on presence, not a fixed word order, so a slightly reworded API
  // message (e.g. "ttl" and "cache_control" swapped) still gets caught —
  // the exact sentence captured live was "a ttl='1h' cache_control block
  // must not come after a ttl='5m' cache_control block".
  return /cache_control/i.test(text) && /must not come after/i.test(text) && /ttl/i.test(text);
}

// --------------------------------------------------------- 0. per-result cap

export interface ToolOutputCap {
  /** The output to store — unchanged, or a clipped string in its place. */
  output: unknown;
  truncated: boolean;
  /** Length of the serialized output, always reported — used by callers to
   *  keep a running estimate of live context size even when nothing was
   *  truncated. */
  originalChars: number;
}

/**
 * Caps a single tool result's serialized size, independent of which tool
 * produced it — built-in, gateway, or MCP (see the file header, defense #1).
 * `maxChars <= 0` disables this. Mirrors how the result is later serialized
 * for the API (`outputToText` in messages.ts: strings pass through, anything
 * else is JSON.stringify'd) so the size checked here matches what the model
 * actually receives.
 */
export function truncateToolOutput(output: unknown, maxChars: number): ToolOutputCap {
  let text: string;
  if (typeof output === "string") text = output;
  else {
    try {
      text = JSON.stringify(output ?? null);
    } catch {
      text = String(output);
    }
  }
  // originalChars is reported even when disabled/under the limit — callers
  // (agent.ts) use it to keep the live contextTokens estimate accurate.
  if (maxChars <= 0 || text.length <= maxChars) return { output, truncated: false, originalChars: text.length };
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  const clipped = `${text.slice(0, head)}\n…[${text.length - maxChars} chars omitted — result exceeded WRONGFORGE_MAX_TOOL_OUTPUT_CHARS (${maxChars})]…\n${text.slice(text.length - tail)}`;
  return { output: clipped, truncated: true, originalChars: text.length };
}

// ------------------------------------------------------- 1. clear tool outputs

/**
 * Replaces the output of all but the last `keepRecent` tool results with a
 * placeholder. Returns new message objects where something changed; the input
 * array and its messages are not mutated.
 */
export function clearOldToolOutputs(
  messages: AgentMessage[],
  keepRecent: number,
): { messages: AgentMessage[]; cleared: number } {
  const slots: { m: number; p: number }[] = [];
  messages.forEach((msg, m) => {
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      msg.content.forEach((part: any, p: number) => {
        if (part?.type === "tool-result") slots.push({ m, p });
      });
    }
  });
  const toClear = slots.slice(0, Math.max(0, slots.length - keepRecent));
  const isCleared = (part: any): boolean => part?.output?.type === "text" && part.output.value === CLEARED_PLACEHOLDER;

  const out = [...messages];
  let cleared = 0;
  for (const { m, p } of toClear) {
    const msg = out[m] as any;
    if (isCleared(msg.content[p])) continue;
    if (out[m] === messages[m]) out[m] = { ...msg, content: [...msg.content] } as AgentMessage;
    (out[m] as any).content[p] = { ...msg.content[p], output: { type: "text", value: CLEARED_PLACEHOLDER } };
    cleared++;
  }
  return { messages: cleared ? out : messages, cleared };
}

// -------------------------------------------------------------- 2. compaction

/** Splits a history into turns; every `user` message starts a new one. */
export function splitTurns(messages: AgentMessage[]): AgentMessage[][] {
  const turns: AgentMessage[][] = [];
  for (const m of messages) {
    if (m.role === "user" || turns.length === 0) turns.push([m]);
    else turns[turns.length - 1]!.push(m);
  }
  return turns;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n} chars]` : s);

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** Plain-text rendering of messages for the summarizer (tool I/O trimmed). */
export function renderTranscript(messages: AgentMessage[], maxChars = 600_000): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push(`USER: ${clip(partsToText(msg.content), 8000)}`);
    } else if (msg.role === "assistant") {
      const text = partsToText(msg.content);
      if (text) lines.push(`ASSISTANT: ${clip(text, 8000)}`);
      if (Array.isArray(msg.content)) {
        for (const p of msg.content as any[]) {
          if (p?.type === "tool-call") lines.push(`  [tool call] ${p.toolName} ${clip(JSON.stringify(p.input ?? {}), 400)}`);
        }
      }
    } else if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const p of msg.content as any[]) {
        if (p?.type !== "tool-result") continue;
        const v = p.output?.value ?? p.output;
        const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
        lines.push(`  [tool result] ${p.toolName}: ${clip(s, 500)}`);
      }
    }
  }
  const full = lines.join("\n");
  if (full.length <= maxChars) return full;
  const head = Math.floor(maxChars * 0.2);
  const tail = maxChars - head;
  return `${full.slice(0, head)}\n…[${full.length - maxChars} chars omitted from the middle]…\n${full.slice(full.length - tail)}`;
}

const SUMMARY_SYSTEM = `You compress the history of a coding agent's work session so the agent can continue it later with no other memory of it.
Write a dense, factual summary in Markdown with these sections:
## Goals
## What was done   (chronological and concrete: files created/changed with their paths, commands run and what they returned)
## Current state
## Decisions and constraints
## Open problems / next steps
## Key facts       (exact paths, ids, names, commands, URLs and error messages worth remembering)
Preserve exact identifiers, paths and error text. Do not invent anything. No preamble, no closing remarks.`;

export const SUMMARY_PREFIX = "[Summary of the earlier part of this session — the full details were archived]";
const SUMMARY_ACK = "Understood. I have the summary of the earlier work and will continue from it.";

export interface CompactResult {
  /** The new, shorter history. */
  messages: AgentMessage[];
  /** The summary text. */
  summary: string;
  messages_before: number;
  messages_after: number;
  turns_summarized: number;
  turns_kept: number;
}

/**
 * Summarizes everything except the last `keepTurns` turns. Returns null when
 * there is nothing to summarize (fewer turns than `keepTurns + 1`).
 * The summary call is made without prompt caching (it is a one-off prefix).
 */
export async function compactMessages(
  client: Anthropic,
  modelId: string,
  messages: AgentMessage[],
  keepTurns: number,
  abortSignal?: AbortSignal,
): Promise<CompactResult | null> {
  const turns = splitTurns(messages);
  if (turns.length <= keepTurns) return null;
  const older = turns.slice(0, turns.length - keepTurns).flat();
  const recent = turns.slice(turns.length - keepTurns).flat();

  // STREAMING is required here, not just preferred: the SDK refuses
  // non-streaming requests it estimates may exceed 10 minutes
  // (calculateNonstreamingTimeout: 60 min × max_tokens / 128k tokens), so the
  // 64_000-token escalation below computes a 30-minute budget and gets thrown
  // away BEFORE the request is ever sent — issue #8 (volkanmidilli): large
  // sessions could never compact and died at the context limit. Streaming
  // skips that check, and finalMessage() hands back the same Message shape
  // (content blocks + stop_reason) the non-streaming call returned.
  const runSummary = (maxTokens: number) =>
    runInContext({ cwd: process.cwd(), env: {}, todos: [], cache: "off" }, () =>
      client.messages
        .stream(
          {
            model: modelId,
            max_tokens: maxTokens,
            system: [{ type: "text", text: SUMMARY_SYSTEM }],
            messages: [{ role: "user", content: renderTranscript(older) }],
          },
          { signal: abortSignal },
        )
        .finalMessage(),
    );
  const extract = (r: Awaited<ReturnType<typeof runSummary>>): string =>
    r.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

  // First attempt at the cheap default budget. A very large session's
  // transcript cannot fit a 4k-token summary (issue #6: a 990-message session
  // bricked itself this way — every retry re-ran the ~150k-input-token call
  // and failed the same way), so escalate ONCE to a 64k output budget before
  // giving up on a summary entirely.
  let res = await runSummary(4000);
  let summary = extract(res);
  if (res.stop_reason === "max_tokens") {
    res = await runSummary(64_000);
    summary = extract(res);
  }

  // max_tokens is a successful response with a truncated body: installing it
  // would replace the conversation with a summary that stops mid-sentence
  // (F602). If even the 64k budget could not finish, recover MECHANICALLY
  // instead — drop the older turns behind an explicitly-labeled placeholder so
  // the session becomes usable again; the truncated summary text is never
  // installed, and the full original is archived by replaceMessages.
  if (res.stop_reason === "max_tokens") {
    const next: AgentMessage[] = [
      {
        role: "user",
        content: `[Session recovery] The earlier part of this session (${older.length} messages) exceeded every summary budget, so those turns were dropped to make the session usable again. No summary of them is available; the full original conversation was archived next to the session files. Continue from the turns below.`,
      },
      { role: "assistant", content: SUMMARY_ACK },
      ...recent,
    ];
    return {
      messages: next,
      summary: "",
      messages_before: messages.length,
      messages_after: next.length,
      turns_summarized: turns.length - keepTurns,
      turns_kept: keepTurns,
    };
  }
  if (!summary) throw new Error("the model returned an empty summary");

  const next: AgentMessage[] = [
    { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}` },
    { role: "assistant", content: SUMMARY_ACK },
    ...recent,
  ];
  return {
    messages: next,
    summary,
    messages_before: messages.length,
    messages_after: next.length,
    turns_summarized: turns.length - keepTurns,
    turns_kept: keepTurns,
  };
}
