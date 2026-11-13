import { tool } from "../tool.js";
import { z } from "zod";
import * as fs from "node:fs/promises";
import { IMAGE_MAX_BYTES } from "../images.js";
import { MAX_READ_BYTES, errText, isBinary, resolvePath, splitLines } from "./util.js";

const READ_CHAR_BUDGET = 40_000; // chars of numbered text per read call
const MAX_LINE_CHARS = 2_000; // a single line longer than this is cut

/** Magic-byte sniff: png/jpeg/gif/webp come back to the model as inline
 *  image blocks — the same shapes Claude Code's Read produces. */
function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  if (buf.length >= 12 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export const read = tool({
  description:
    "Reads a file and returns it with 1-based numbered lines (cat -n style). " +
    "Images (png/jpeg/gif/webp, ≤ 5 MB) come back as inline images the model can see. " +
    "Returns at most 2000 lines / ~40k characters per call; when `truncated` is " +
    "true, call again with offset=nextOffset. Very long lines are cut. Fails for " +
    "directories (use ls) and files over 10 MB (use grep). " +
    "Always read a file before editing it.",
  inputSchema: z.object({
    path: z.string().describe("File path (relative or absolute; ~ is expanded)"),
    offset: z.number().int().min(1).optional().describe("1-based start line"),
    limit: z
      .number()
      .int()
      .positive()
      .max(2000)
      .optional()
      .describe("Max lines to return (default 2000)"),
  }),
  execute: async ({ path: p, offset, limit }) => {
    try {
      const abs = resolvePath(p);
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        return { ok: false, error: `${abs} is a directory — use ls to list it` };
      }
      if (st.size > MAX_READ_BYTES) {
        const mb = (st.size / 1024 / 1024).toFixed(1);
        return {
          ok: false,
          error: `file is ${mb} MB (limit 10 MB) — use grep, or bash with head/tail, instead`,
        };
      }
      const buf = await fs.readFile(abs);
      // images first: png/jpeg/gif/webp are IN, everything else binary stays out
      const imageType = sniffImage(buf);
      if (imageType) {
        if (buf.length > IMAGE_MAX_BYTES) {
          return {
            ok: false,
            error: `image is ${(buf.length / 1024 / 1024).toFixed(1)} MB — the API limit is 5 MB per image. Please resize the image manually or use a smaller image.`,
          };
        }
        // the `images` array is the wire convention (messages.ts outputImages)
        // — it rides as API image blocks inside the tool_result
        return {
          ok: true,
          type: "image",
          path: abs,
          bytes: buf.length,
          note: `image (${imageType}) attached — describe it from what you can see`,
          images: [{ media_type: imageType, data: buf.toString("base64") }],
        };
      }
      if (isBinary(buf)) {
        const kind = buf.length >= 2 && buf[0] === 0x25 && buf[1] === 0x50 ? "PDF" : "binary file (contains NUL bytes)";
        return { ok: false, error: `${kind} — not shown${kind === "PDF" ? " (image files png/jpeg/gif/webp are readable)" : ""}` };
      }
      let content = buf.toString("utf8");
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1); // BOM
      const lines = splitLines(content);
      if (lines.length === 0) {
        return {
          ok: true,
          path: abs,
          totalLines: 0,
          shownFrom: 0,
          shownTo: 0,
          truncated: false,
          content: "",
          note: "file is empty",
        };
      }
      const start = (offset ?? 1) - 1;
      if (start >= lines.length) {
        return {
          ok: false,
          error: `offset ${offset} is beyond the end of the file (${lines.length} lines)`,
        };
      }
      const cap = limit ?? 2000;
      const rows: string[] = [];
      let chars = 0;
      for (let i = start; i < lines.length && i < start + cap; i++) {
        let l = lines[i];
        if (l.length > MAX_LINE_CHARS) {
          l = `${l.slice(0, MAX_LINE_CHARS)}…[line truncated, ${lines[i].length} chars]`;
        }
        const row = String(i + 1).padStart(6) + "\t" + l;
        if (rows.length > 0 && chars + row.length > READ_CHAR_BUDGET) break;
        rows.push(row);
        chars += row.length + 1;
      }
      const shownTo = start + rows.length;
      const truncated = shownTo < lines.length;
      return {
        ok: true,
        path: abs,
        totalLines: lines.length,
        shownFrom: start + 1,
        shownTo,
        truncated,
        ...(truncated && { nextOffset: shownTo + 1 }),
        content: rows.join("\n"),
      };
    } catch (e) {
      return { ok: false, error: errText(e, p) };
    }
  },
});
