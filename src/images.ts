/**
 * Image attachments for tasks and tool results.
 *
 * The Anthropic Messages API accepts base64 images as content blocks
 * (`{type: "image", source: {type: "base64", media_type, data}}`) inside a
 * user message or a tool_result — the same shape Claude Code sends when its
 * Read tool opens an image (carve re/notes/findings.md §25: png/jpeg/gif/
 * webp, byte and dimension limits enforced by the backend, media-type
 * mismatch is its own error).
 *
 * Two paths use this module:
 *  - task submit: `images` on the request body are validated here, written
 *    to the task dir as files, and referenced from the task record — the
 *    multi-MB base64 blobs never sit in task.json, the audit trail or logs;
 *  - execute/read: the bytes are re-read at request time and inlined as
 *    content blocks (see messages.ts).
 *
 * Limits mirror the API: png/jpeg/gif/webp only, ≤ 5 MB decoded per image,
 * ≤ 5 images per submit. Magic bytes must match the declared media type —
 * a mismatch is its own refusal ("image does not match the provided media
 * type" is what the backend answers with).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_MAX_COUNT = 5;

export interface ValidatedImage {
  media_type: ImageMediaType;
  /** Decoded bytes. */
  bytes: Buffer;
  /** The original base64 as submitted (reused verbatim on the wire). */
  data: string;
}

export interface ImageInput {
  media_type?: unknown;
  data?: unknown;
}

/** Detected from magic bytes — an extension lie does not pass. */
function sniff(buf: Buffer): ImageMediaType | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/**
 * Validates a submit's `images` array. Throws nothing — returns a
 * human-readable error string on the first problem, or the decoded images.
 */
export function validateImages(images: unknown): { error: string } | { images: ValidatedImage[] } {
  if (images === undefined) return { images: [] };
  if (!Array.isArray(images)) return { error: "`images` must be an array of { media_type, data (base64) }" };
  if (images.length > IMAGE_MAX_COUNT) return { error: `\`images\` may contain at most ${IMAGE_MAX_COUNT} images (got ${images.length})` };
  const out: ValidatedImage[] = [];
  for (const [i, img] of images.entries()) {
    const { media_type, data } = (img ?? {}) as ImageInput;
    if (typeof media_type !== "string" || !(IMAGE_MEDIA_TYPES as readonly string[]).includes(media_type)) {
      return { error: `\`images[${i}].media_type\` must be one of ${IMAGE_MEDIA_TYPES.join(", ")}` };
    }
    if (typeof data !== "string" || data.length === 0) return { error: `\`images[${i}].data\` must be non-empty base64` };
    const bytes = Buffer.from(data, "base64");
    // base64 round-trip: a non-base64 string decodes lossily and the sizes diverge
    if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== data.replace(/=+$/, "").replace(/\s+/g, "")) {
      return { error: `\`images[${i}].data\` is not valid base64` };
    }
    const sniffed = sniff(bytes);
    if (!sniffed) return { error: `\`images[${i}]\` bytes are not a recognized png/jpeg/gif/webp image` };
    if (sniffed !== media_type) return { error: `\`images[${i}]\` bytes are ${sniffed}, not the declared ${media_type} ("image does not match the provided media type")` };
    if (bytes.length > IMAGE_MAX_BYTES) {
      return { error: `\`images[${i}]\` is ${(bytes.length / 1024 / 1024).toFixed(1)} MB decoded — the API limit is 5 MB per image; resize and resend` };
    }
    out.push({ media_type: sniffed, bytes, data });
  }
  return { images: out };
}

const EXT: Record<ImageMediaType, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/**
 * Persists validated images under `<taskDir>/images/NN.<ext>` and returns
 * the record-shaped references (metadata only — no base64 in task.json).
 */
export function writeTaskImages(taskDir: string, images: ValidatedImage[]): Array<{ file: string; media_type: ImageMediaType; bytes: number }> {
  if (!images.length) return [];
  const dir = path.join(taskDir, "images");
  fs.mkdirSync(dir, { recursive: true });
  return images.map((img, i) => {
    // forward slashes: the ref lands in JSON (task.json, API responses) and
    // Windows path.join accepts "images/00.png" as-is
    const file = `images/${String(i).padStart(2, "0")}.${EXT[img.media_type]}`;
    fs.writeFileSync(path.join(taskDir, file), img.bytes);
    return { file, media_type: img.media_type, bytes: img.bytes.length };
  });
}

/** Re-reads a task's persisted images as base64 for the wire. */
export function readTaskImages(taskDir: string, refs: Array<{ file: string; media_type: ImageMediaType }>): Array<{ media_type: ImageMediaType; data: string }> {
  return refs.map((r) => ({
    media_type: r.media_type,
    data: fs.readFileSync(path.join(taskDir, r.file)).toString("base64"),
  }));
}
