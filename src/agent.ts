/**
 * Agent loop: system prompt + tools + multi-step (agentic) execution.
 *
 * Runs on the official Anthropic SDK (`@anthropic-ai/sdk`): each step streams
 * one /v1/messages call, tool_use blocks are executed locally, their results
 * are appended and the model continues — the core Claude Code working
 * pattern. The client itself (OAuth headers, Claude Code client signature,
 * betas, prompt-cache breakpoints) is assembled in provider.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { agentTools } from "./tools/index.js";
import { clearOldToolOutputs, estimateTokens, truncateToolOutput } from "./compaction.js";
import { effectiveEffort, resolveEffort } from "./effort.js";
import { runTool, type ToolSet } from "./tool.js";
import { fromApiAssistantMessage, toApiMessages, type AgentMessage } from "./messages.js";
import { toApiInputSchema } from "./tools/util.js";

/**
 * Current model lineup — platform.claude.com/docs/en/models/overview (Oct 2026).
 * Dateless IDs are pinned snapshots; the /models command queries
 * GET /v1/models for the live list.
 */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const KNOWN_MODELS: Record<string, string> = {
  // current-generation defaults (the four an orchestrator usually picks)
  "claude-sonnet-5-5": "balanced default — coding and agent work ($2/$10 per MTok)",
  "claude-opus-5-5": "Anthropic's recommendation for most workloads ($4/$20 per MTok)",
  "claude-fable-5-2": "current default Fable — deepest reasoning ($8/$40 per MTok, $0.20 cache reads; CC 2.1.325 release notes)",
  "claude-mythos-5-2": "latest Mythos generation",
  "claude-haiku-5-5": "fast and economical, high volume ($0.10/$0.50 per MTok)",
  // prior generations still served by the API (CC 2.1.330 catalog)
  "claude-sonnet-5": "first Sonnet 5 generation; superseded by 5-5",
  "claude-sonnet-4-6": "prior-generation Sonnet",
  "claude-sonnet-4-5-2": "prior-generation Sonnet 4.5 refresh",
  "claude-opus-5": "first Opus 5 generation; superseded by 5-5",
  "claude-opus-4-8": "Opus 4.8 (pre-5.x flagship)",
  "claude-opus-4-7": "prior Opus generation",
  "claude-opus-4-6": "prior Opus generation",
  "claude-opus-4-5-2": "prior-generation Opus 4.5 refresh",
  "claude-fable-5": "first Fable generation",
  "claude-fable-5-1": "prior Fable generation — long agent runs ($10/$50 per MTok)",
  "claude-mythos-5": "first Mythos generation",
  "claude-mythos-5-1": "prior Mythos generation",
  "claude-haiku-4-5-2": "Haiku 4.5 refresh",
};

export const SYSTEM_PROMPT = `You are a terminal-based AI coding assistant running on the user's machine.

Working directory: the shell's current working directory.

Tools:
- bash: run shell commands (builds, tests, git, search); non-interactive flags preferred
- read: read a file with numbered lines (offset/limit for large files)
- write: write new files or full rewrites
- edit: exact string replacement in an existing file
- ls / glob / grep: explore directories, find files by pattern, search contents
- web_fetch: read a public URL as text
- todo_read / todo_write: track a multi-step plan
- report_progress: send a short status update to the orchestrator that started you
- mcp_servers / mcp_tools / mcp_call: use tools of MCP servers (list servers, discover a server's tools and schemas, call a tool); tools named mcp_<server>_<tool> are the same tools, already typed
- mcp_add / mcp_remove: add or remove an MCP server (http, sse or stdio) when a task needs a capability you do not have; reference secrets as \${ENV_VAR}, never write them out

Operating principles:
1. Verify with tools instead of guessing — locate code with glob/grep, then read before editing.
2. For edits, old_string must match exactly and be unique; include surrounding lines for context.
3. Work step by step: read first, then edit; prefer minimal, surgical changes.
4. For multi-step tasks, record the plan with todo_write and keep statuses current.
5. After making changes, validate them (compile, run tests) when practical.
6. Destructive or hard-to-reverse actions (deleting files, force-push, installs) require asking the user first.
7. Answer in the user's language. Be concise; show command output only when it matters.`;

export interface TokenUsage {
  /** All input tokens (cache reads and writes included). */
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Input tokens served from the prompt cache (cheap). */
  cache_read_tokens: number;
  /** Input tokens written to the prompt cache. */
  cache_write_tokens: number;
}

export interface TurnResult {
  finishReason: string;
  toolCalls: number;
  /** Assistant text of this turn (all steps concatenated). */
  text: string;
  /** Number of model steps (LLM round-trips) in this turn. */
  steps: number;
  /** Token usage summed over all steps. */
  usage: TokenUsage;
  /**
   * Size of the conversation after this turn, in tokens: the last request's
   * input (cache included) plus its output. This is what the NEXT request will
   * start from — the number to watch against the context window.
   */
  context_tokens: number;
}

/** In-task context guard (see compaction.ts). */
export interface ContextGuard {
  /** Clear old tool outputs once the live context exceeds this many tokens. */
  clearAt: number;
  /** Most recent tool results that are never cleared. */
  keepToolResults: number;
  /** A single tool result bigger than this (chars, 0 = never) is clipped
   *  before it reaches history, regardless of which tool produced it. */
  maxToolResultChars: number;
}

/** Structured events emitted while a turn runs (used by the HTTP server). */
export type AgentEvent =
  | { type: "step_start"; step: number }
  | {
      type: "step_request";
      step: number;
      model: string;
      /** Resolved effort sent with the request; null = the field is omitted. */
      effort: string | null;
      max_tokens: number;
      messages: number;
      tools: number;
    }
  | { type: "step_finish"; step: number; finish_reason: string; usage: TokenUsage; context_tokens: number }
  | { type: "context_cleared"; cleared: number; context_tokens: number }
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; output: unknown }
  | { type: "tool_error"; id: string; name: string; error: string }
  | { type: "tool_output_truncated"; id: string; name: string; original_chars: number }
  | { type: "error"; error: string };

// ------------------------------------------------------------------- tool defs

function apiToolSet(tools: ToolSet): Anthropic.Messages.Tool[] {
  return Object.entries(tools).map(([name, t]) => {
    const schema = t.inputJsonSchema ?? z.toJSONSchema(t.inputSchema ?? z.object({}), { target: "draft-2020-12" });
    return {
      name,
      description: t.description,
      // the API accepts a plain object only — orchestrator/MCP schemas with a
      // top-level oneOf/allOf/anyOf are flattened (see toApiInputSchema)
      input_schema: toApiInputSchema(schema),
    };
  });
}

// ----------------------------------------------------------------- agent turn

// CC 2.1.300 asks for the model ceiling on main turns (captured: 128000)
const MAX_OUTPUT_TOKENS = 128_000;

/**
 * Runs one agent turn. Without `onEvent` it prints to the terminal (REPL);
 * with `onEvent` every text delta / tool call / tool result is delivered as a
 * structured event instead and nothing is printed.
 */
export async function runAgentTurn(
  client: Anthropic,
  modelId: string,
  history: AgentMessage[],
  maxSteps = 20,
  abortSignal?: AbortSignal,
  onEvent?: (e: AgentEvent) => void,
  system: string = SYSTEM_PROMPT,
  guard?: ContextGuard,
  extraTools: ToolSet = {},
  /** Allowlist of built-in tools (undefined = all); extraTools are always included. */
  builtinTools?: readonly string[],
): Promise<TurnResult> {
  const builtins: ToolSet = builtinTools
    ? Object.fromEntries(Object.entries(agentTools).filter(([name]) => builtinTools.includes(name)))
    : agentTools;
  const tools: ToolSet = { ...builtins, ...extraTools };
  const apiTools = apiToolSet(tools);
  const systemBlocks = [{ type: "text" as const, text: system }];

  let toolCalls = 0;
  let text = "";
  let steps = 0;
  let contextTokens = 0;
  let finishReason = "unknown";
  const usage: TokenUsage = {
    input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
  };

  // In-task context guard (the prepareStep equivalent): once the live context
  // passes clearAt, replace old tool outputs with a placeholder. Called both
  // at the top of the loop AND right after a tool result is appended — see
  // compaction.ts's file header (defense #2) for why the latter matters: the
  // API's real usage numbers only arrive with the NEXT response, too late to
  // catch a result that alone jumps contextTokens past clearAt.
  const applyClearGuard = (): void => {
    if (guard && guard.clearAt > 0 && contextTokens >= guard.clearAt) {
      const r = clearOldToolOutputs(history, guard.keepToolResults);
      if (r.cleared) {
        onEvent?.({ type: "context_cleared", cleared: r.cleared, context_tokens: contextTokens });
      }
    }
  };

  try {
    while (steps < maxSteps) {
      applyClearGuard();

      steps++;
      onEvent?.({ type: "step_start", step: steps });
      // What is about to go OUT to the model — the request half of the live
      // traffic view (the response half is text/tool/step_finish events).
      onEvent?.({
        type: "step_request",
        step: steps,
        model: modelId,
        effort: resolveEffort(effectiveEffort(modelId), modelId).effort,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: history.length,
        tools: apiTools.length,
      });

      const stream = client.messages.stream(
        {
          model: modelId,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: systemBlocks,
          messages: toApiMessages(history),
          tools: apiTools,
        },
        { signal: abortSignal },
      );

      // Text deltas are surfaced live; tool_use inputs arrive as JSON deltas
      // that we accumulate and emit once the block is complete.
      let openTool: { id: string; name: string; json: string } | null = null;
      for await (const ev of stream) {
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") {
            text += ev.delta.text;
            if (onEvent) onEvent({ type: "text", delta: ev.delta.text });
            else process.stdout.write(ev.delta.text);
          } else if (ev.delta.type === "input_json_delta" && openTool) {
            openTool.json += ev.delta.partial_json;
          }
        } else if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
          openTool = { id: ev.content_block.id, name: ev.content_block.name, json: "" };
        } else if (ev.type === "content_block_stop" && openTool) {
          const input = openTool.json ? JSON.parse(openTool.json) : {};
          toolCalls++;
          if (onEvent) onEvent({ type: "tool_call", id: openTool.id, name: openTool.name, input });
          else console.log(`\n\x1b[36m▸ ${openTool.name}\x1b[0m ${summarize(input)}`);
          openTool = null;
        }
      }

      const final = await stream.finalMessage();
      finishReason = final.stop_reason ?? finishReason;

      const u: TokenUsage = {
        input_tokens: final.usage.input_tokens,
        output_tokens: final.usage.output_tokens,
        total_tokens: final.usage.input_tokens + final.usage.output_tokens,
        cache_read_tokens: final.usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: final.usage.cache_creation_input_tokens ?? 0,
      };
      usage.input_tokens += u.input_tokens;
      usage.output_tokens += u.output_tokens;
      usage.total_tokens += u.total_tokens;
      usage.cache_read_tokens += u.cache_read_tokens;
      usage.cache_write_tokens += u.cache_write_tokens;
      // The true size of the NEXT request's prompt: uncached input + both
      // cache components + output. With prompt caching the API's
      // `input_tokens` is only the uncached tail — ignoring the cache
      // components made context_tokens report ~1-2k for a ~1M-token prompt,
      // so neither compact_at nor the in-task clear_at guard could ever fire
      // (issue #5).
      contextTokens = u.input_tokens + u.cache_read_tokens + u.cache_write_tokens + u.output_tokens;
      onEvent?.({
        type: "step_finish", step: steps, finish_reason: String(finishReason), usage: u, context_tokens: contextTokens,
      });

      // Append the assistant message; tool results go into a follow-up `tool`
      // message, exactly like the stored history has always looked.
      history.push(fromApiAssistantMessage(final.content as never));
      const toolUses = final.content.filter((b) => b.type === "tool_use") as Array<{
        id: string; name: string; input: unknown;
      }>;
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

      const results = [];
      let appendedChars = 0;
      const maxToolResultChars = guard?.maxToolResultChars ?? 0;
      for (const call of toolUses) {
        const r = await runTool(tools[call.name], call.input, {
          abortSignal,
          toolCallId: call.id,
        });
        // Cap a single result's size here, before it ever reaches history —
        // the one defense that works regardless of which tool produced it
        // (built-in tools already self-limit; MCP/gateway tools may not).
        // See compaction.ts's file header, defense #1.
        const rawOutput = r.ok ? r.output : { ok: false, error: r.error };
        const cap = truncateToolOutput(rawOutput, maxToolResultChars);
        appendedChars += cap.originalChars;
        if (cap.truncated) {
          onEvent?.({ type: "tool_output_truncated", id: call.id, name: call.name, original_chars: cap.originalChars });
        }
        if (r.ok) {
          if (onEvent) onEvent({ type: "tool_result", id: call.id, name: call.name, output: cap.output });
          else console.log(`\n\x1b[2m  ↳ ${summarize(cap.output)}\x1b[0m`);
        } else {
          if (onEvent) onEvent({ type: "tool_error", id: call.id, name: call.name, error: r.error });
          else console.error(`\n\x1b[31m  ↳ tool error: ${r.error}\x1b[0m`);
        }
        results.push({ type: "tool-result" as const, toolCallId: call.id, toolName: call.name, output: cap.output });
      }
      history.push({ role: "tool", content: results });
      // Proactive estimate (see compaction.ts's file header, defense #2): the
      // API's real usage numbers only arrive with the NEXT response, which is
      // too late for the guard below to catch a result that alone jumps past
      // clearAt. This estimate exists purely to make that check fire at the
      // right moment — the next step_finish event overwrites it with the
      // real count regardless.
      contextTokens += estimateTokens(appendedChars);
      applyClearGuard();
    }
  } catch (e) {
    if (abortSignal?.aborted) {
      // An interrupted turn may end mid tool-call; its partial messages would
      // leave a dangling tool_use in the history, so the caller rolls the turn back.
      return { finishReason: "aborted", toolCalls, text, steps, usage, context_tokens: contextTokens };
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (onEvent) onEvent({ type: "error", error: msg });
    else console.error(`\x1b[31m[error] ${msg}\x1b[0m`);
    if (finishReason === "unknown") finishReason = "error";
  }

  return {
    finishReason,
    toolCalls,
    text,
    steps,
    usage,
    context_tokens: contextTokens,
  };
}

function summarize(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined || text === "undefined") text = "";
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 140 ? oneLine.slice(0, 140) + "…" : oneLine;
}
