/**
 * The Proxy tab's human-readable summaries: every wire shape that feeds
 * summarizeAnthropicRequest / summarizeAnthropicResponse — parsed and raw,
 * streaming and not, error envelopes, truncated captures — plus the
 * never-throws contract (summarizing is a convenience; odd shapes fall back
 * to "raw", never an exception).
 */

import { describe, expect, it } from "vitest";
import { summarizeAnthropicRequest, summarizeAnthropicResponse, summarizeContentBlocks } from "./anthropicSummary.js";

describe("summarizeContentBlocks", () => {
  it("joins blocks with separators and trims whitespace", () => {
    expect(summarizeContentBlocks([{ type: "text", text: "  a  b " }, { type: "text", text: "c" }])).toBe("a b · c");
  });

  it("labels non-text blocks and clips long text", () => {
    expect(summarizeContentBlocks([{ type: "thinking" }])).toBe("(thinking)");
    expect(summarizeContentBlocks([{ type: "tool_use", name: "bash", input: { command: "ls" } }])).toContain("⇢ bash(");
    const long = summarizeContentBlocks([{ type: "text", text: "x".repeat(300) }]);
    expect(long.length).toBeLessThanOrEqual(101);
    expect(long.endsWith("…")).toBe(true);
  });

  it("handles plain strings, empty arrays and junk without throwing", () => {
    expect(summarizeContentBlocks("plain")).toBe("plain");
    expect(summarizeContentBlocks([])).toBe("");
    expect(summarizeContentBlocks(undefined)).toBe("");
    expect(summarizeContentBlocks([{ type: 42 }])).toContain("(42)");
  });
});

describe("summarizeAnthropicRequest", () => {
  it("shows model, message count, tool count and the last message", () => {
    const out = summarizeAnthropicRequest({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: [{ type: "text", text: "older" }] },
        { role: "user", content: [{ type: "text", text: "the actual ask" }] },
      ],
      tools: [{ name: "a" }, { name: "b" }, { name: "c" }],
    });
    expect(out).toContain("model=claude-sonnet-5-5");
    expect(out).toContain("2 msgs");
    expect(out).toContain("3 tools");
    expect(out).toContain("user: the actual ask");
  });

  it("singular message count and the raw fallback for junk shapes", () => {
    expect(summarizeAnthropicRequest({ model: "m", messages: [{ role: "user", content: "hi" }] })).toContain("1 msg");
    expect(summarizeAnthropicRequest(null)).toBe("raw");
    expect(summarizeAnthropicRequest("not an object")).toBe("raw");
  });
});

describe("summarizeAnthropicResponse — parsed objects", () => {
  it("joins finish reason, usage line and content", () => {
    const out = summarizeAnthropicResponse({
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [{ type: "text", text: "the answer" }],
    });
    expect(out).toContain("finish=end_turn");
    expect(out).toContain("in=10 out=20");
    expect(out).toContain("the answer");
  });

  it("appends cache write/read counts when the API reports them", () => {
    const out = summarizeAnthropicResponse({
      usage: { input_tokens: 1000, output_tokens: 5, cache_creation_input_tokens: 900, cache_read_input_tokens: 50 },
      content: [],
    });
    expect(out).toContain("cache +900w/50r");
  });

  it("summarizes Anthropic error envelopes (checked before the message parse)", () => {
    const out = summarizeAnthropicResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down  " } });
    expect(out).toContain("error: rate_limit_error — slow down");
  });
});

describe("summarizeAnthropicResponse — streaming SSE replay", () => {
  const sse = [
    "event: message_start",
    `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 30, output_tokens: 1 } } })}`,
    "",
    "event: content_block_start",
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial an" } })}`,
    "",
    "event: content_block_delta",
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "swer" } })}`,
    "",
    "event: message_delta",
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } })}`,
    "",
    "event: message_stop",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n\n");

  it("reconstructs the final message from raw SSE text", () => {
    const out = summarizeAnthropicResponse(sse, { stream: true });
    expect(out).toContain("finish=end_turn");
    expect(out).toContain("in=30 out=7");
    expect(out).toContain("partial answer");
  });

  it("assembles tool_use input from partial_json deltas", () => {
    const toolSse = [
      "event: content_block_start",
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "bash" } })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":' } })}`,
      "",
      "event: content_block_delta",
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"ls"}' } })}`,
      "",
    ].join("\n\n");
    const out = summarizeAnthropicResponse(toolSse, { stream: true });
    expect(out).toContain("⇢ bash(");
    expect(out).toContain('"command":"ls"');
  });

  it("tolerates a truncated capture and non-JSON tails", () => {
    const truncated = sse.slice(0, sse.length - 80); // cut mid-event
    const out = summarizeAnthropicResponse(truncated, { stream: true });
    expect(typeof out).toBe("string");
    expect(out).toContain("partial an");
    expect(summarizeAnthropicResponse("data: not json\n\n", { stream: true })).toBe("raw");
  });
});

describe("summarizeAnthropicResponse — non-streaming raw text + never-throws", () => {
  it("clips plain non-JSON bodies", () => {
    const out = summarizeAnthropicResponse("plain gateway text", {});
    expect(out).toBe("plain gateway text");
  });

  it("parses a raw JSON string body too", () => {
    const out = summarizeAnthropicResponse(JSON.stringify({ error: { type: "overloaded_error", message: "busy" } }), {});
    expect(out).toContain("error: overloaded_error — busy");
  });

  it("falls back to raw on truly odd shapes", () => {
    expect(summarizeAnthropicResponse(42, {})).toBe("raw");
    expect(summarizeAnthropicResponse({ stop_reason: "end_turn", content: [{ type: "text", text: "weird-but-fine" }] }, {})).toContain("weird-but-fine");
  });
});
