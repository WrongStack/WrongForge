/**
 * WrongForge's conversation history format and its conversion to/from the
 * Anthropic Messages API wire format.
 *
 * The stored shape is deliberately the same JSON the Vercel AI SDK's
 * ModelMessage used (roles user/assistant/tool with `text`, `tool-call` and
 * `tool-result` parts), so existing session files and compaction keep
 * working unchanged. Conversion to the API's shape (tool_use blocks in
 * assistant messages, tool_result blocks in user messages) happens here,
 * right before each request.
 */

export interface TextPart {
  type: "text";
  text: string;
}

/** An inline base64 image in a user message (validated + limited by
 *  src/images.ts). Serialized as an API image content block. */
export interface ImagePart {
  type: "image";
  media_type: string;
  /** base64, no data: prefix. */
  data: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
}

export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: unknown;
}

export type AgentMessage =
  | { role: "user"; content: string | (TextPart | ImagePart)[] }
  | { role: "assistant"; content: string | (TextPart | ToolCallPart)[] }
  | { role: "tool"; content: ToolResultPart[] };

// ------------------------------------------------------ to the API wire format

export interface ApiTextBlock {
  type: "text";
  text: string;
}
/** The API accepts exactly these four — validateImages()/read.ts only ever
 *  emit these; MCP images outside the set are summarized, not forwarded. */
export type ApiImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const IMAGE_MEDIA_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
export interface ApiImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ApiImageMediaType; data: string };
}
export interface ApiToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
export interface ApiToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | (ApiTextBlock | ApiImageBlock)[];
}
export type ApiContentBlock = ApiTextBlock | ApiImageBlock | ApiToolUseBlock | ApiToolResultBlock;
export interface ApiMessage {
  role: "user" | "assistant";
  content: ApiContentBlock[];
}

/** True for a tool-result output that carries inline images (a tool that
 *  read/produced an image — e.g. read on a .png). The images ride as API
 *  image blocks next to a text summary, not as megabytes of JSON. Media
 *  types outside the API's four are dropped (returned in `skipped`). */
export function outputImages(output: unknown): { images: Array<{ media_type: ApiImageMediaType; data: string }>; skipped: number } | null {
  if (!output || typeof output !== "object") return null;
  const images = (output as { images?: unknown }).images;
  if (!Array.isArray(images) || images.length === 0) return null;
  const out: Array<{ media_type: ApiImageMediaType; data: string }> = [];
  let skipped = 0;
  for (const img of images) {
    const o = img as { media_type?: unknown; data?: unknown };
    if (typeof o?.media_type !== "string" || typeof o?.data !== "string" || o.data.length === 0) continue;
    if (!IMAGE_MEDIA_TYPES.includes(o.media_type)) {
      skipped++;
      continue;
    }
    out.push({ media_type: o.media_type as ApiImageMediaType, data: o.data });
  }
  if (!out.length && !skipped) return null;
  return { images: out, skipped };
}

function outputToText(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output ?? null);
  } catch {
    return String(output);
  }
}

/**
 * Converts the stored history into API messages. `tool` messages become user
 * messages carrying tool_result blocks — the API has no tool role.
 */
export function toApiMessages(history: AgentMessage[]): ApiMessage[] {
  const out: ApiMessage[] = [];
  for (const msg of history) {
    if (msg.role === "user") {
      const blocks: ApiContentBlock[] = [];
      if (typeof msg.content === "string") {
        if (msg.content) blocks.push({ type: "text", text: msg.content });
      } else {
        for (const p of msg.content) {
          if (p.type === "text") blocks.push({ type: "text", text: p.text });
          else {
            // the media_type was validated against the four-image whitelist
            // at the boundary (submit: validateImages; read: magic-byte sniff)
            blocks.push({ type: "image", source: { type: "base64", media_type: p.media_type as ApiImageMediaType, data: p.data } });
          }
        }
      }
      if (blocks.length) out.push({ role: "user", content: blocks });
    } else if (msg.role === "assistant") {
      const blocks: ApiContentBlock[] =
        typeof msg.content === "string"
          ? msg.content
            ? [{ type: "text", text: msg.content }]
            : []
          : msg.content.map((p) =>
              p.type === "text"
                ? { type: "text" as const, text: p.text }
                : { type: "tool_use" as const, id: p.toolCallId, name: p.toolName, input: p.input ?? {} },
            );
      if (blocks.length) out.push({ role: "assistant", content: blocks });
    } else {
      const results: ApiToolResultBlock[] = [];
      for (const p of msg.content) {
        const found = outputImages(p.output);
        if (found) {
          // images ride as API image blocks inside the tool_result; the
          // remaining fields (paths, notes) stay as the text part
          const rest = { ...(p.output as Record<string, unknown>), images: undefined };
          const note = found.skipped
            ? `${found.skipped} image(s) in an unsupported format were dropped`
            : "";
          results.push({
            type: "tool_result",
            tool_use_id: p.toolCallId,
            content: [
              ...found.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.media_type, data: i.data } })),
              { type: "text" as const, text: [note, outputToText(rest)].filter(Boolean).join("\n") },
            ],
          });
        } else {
          results.push({ type: "tool_result", tool_use_id: p.toolCallId, content: outputToText(p.output) });
        }
      }
      if (results.length) out.push({ role: "user", content: results });
    }
  }
  return out;
}

/** Renders a finished API message back into the stored shape (history push). */
export function fromApiAssistantMessage(content: Array<{ type: string } & Record<string, unknown>>): AgentMessage {
  const parts: (TextPart | ToolCallPart)[] = [];
  for (const b of content) {
    if (b.type === "text") parts.push({ type: "text", text: String(b.text ?? "") });
    else if (b.type === "tool_use") parts.push({ type: "tool-call", toolCallId: String(b.id), toolName: String(b.name), input: b.input ?? {} });
  }
  return { role: "assistant", content: parts };
}
