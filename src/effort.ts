/**
 * Reasoning effort for /v1/messages requests (the `effort` field).
 *
 * Effort-capable Claude models accept `effort: "low" | "medium" | "high" |
 * "xhigh" | "max"`, trading answer depth for output tokens. The field rides
 * behind the `effort-2025-11-24` beta header (provider.ts sends it on every
 * request, exactly like Claude Code 2.1.300 does) — without that beta the
 * endpoint rejects the body with "effort: Extra inputs are not permitted".
 * `effortSupport()` maps model ids to the levels they accept and
 * `resolveEffort()` clamps a requested setting to the nearest supported one,
 * so one setting works across the whole lineup (asking "high" on a model that
 * tops out at "medium" sends "medium", not an API error).
 *
 * Setting (per task via the `effort` submit field, REPL via /effort, default
 * from WRONGFORGE_EFFORT):
 *   "low" … "max"               send that effort, clamped to model support
 *   "off"                       never send the field
 *
 * Unknown/future model ids (e.g. live /v1/models entries newer than the
 * table below) are assumed effort-capable; if the API then rejects the
 * parameter, provider.ts drops it, retries once and stops sending it for
 * THAT model — the same self-healing cache_control already uses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { currentContext } from "./context.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

/** A configured effort: a level, or "off" to omit the field entirely. */
export type EffortSetting = Effort | "off";

export const EFFORT_SETTINGS: readonly EffortSetting[] = ["low", "medium", "high", "xhigh", "max", "off"];

export function isEffort(v: unknown): v is Effort {
  return typeof v === "string" && (EFFORTS as readonly string[]).includes(v);
}

export function isEffortSetting(v: unknown): v is EffortSetting {
  return typeof v === "string" && (EFFORT_SETTINGS as readonly string[]).includes(v);
}

/** Server-wide default: WRONGFORGE_EFFORT, falling back to "high". */
export function defaultEffort(env: NodeJS.ProcessEnv = process.env): EffortSetting {
  const v = env.WRONGFORGE_EFFORT?.trim().toLowerCase();
  return isEffortSetting(v) ? v : "high";
}

// ------------------------------------------------------------- model support

const ALL = EFFORTS;
const NONE: readonly Effort[] = [];

/**
 * Which model families accept `effort`. Mirrors the capability table carved
 * from Claude Code 2.1.300 (re/artifacts/ccmods/mod-0034.mjs, `Vme` → the
 * family set `Ib` that gates the field in mod-0150 `Db`/mod-0422 `Wze`):
 * everything from the 3.5 generation through the 5.x lineup — sonnet, opus,
 * haiku, fable and mythos — is effort-capable, including claude-sonnet-5-5
 * and claude-opus-5-5. Only the pre-3.5 era (claude-3-*, claude-2*) lacks it.
 * Unknown ids (anything newer than this table) are assumed capable, same
 * fallback CC's client uses before its served catalog answers.
 */
const EFFORT_RULES: Array<[RegExp, readonly Effort[]]> = [
  // the pre-3.5 era has no effort field — Vme starts at 3-5/3-7
  [/^claude-3-(?!5|7)/, NONE],
  [/^claude-2/, NONE],
];

/** Which effort levels a model id accepts (empty = the model has none). */
export function effortSupport(model: string): readonly Effort[] {
  for (const [re, levels] of EFFORT_RULES) {
    if (re.test(model)) return levels;
  }
  return ALL;
}

// ---------------------------------------------------------------- resolution

const RANK: Record<Effort, number> = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4 };

/** Nearest supported level to `setting` (ties prefer the lower one). */
export function clampEffort(setting: Effort, supported: readonly Effort[]): Effort {
  const want = RANK[setting];
  let best = supported[0];
  for (const lvl of supported) {
    if (Math.abs(RANK[lvl] - want) < Math.abs(RANK[best] - want)) best = lvl;
  }
  return best;
}

export interface ResolvedEffort {
  /** Value for the request's `effort` field; null = omit the field. */
  effort: Effort | null;
  /** True when the setting was adjusted to what the model supports. */
  clamped: boolean;
  /** True when the model has no effort support at all. */
  unsupported: boolean;
}

/**
 * Maps a setting onto a model: "off" and effort-incapable models omit the
 * field; a level the model lacks is clamped to the nearest one it has.
 */
export function resolveEffort(setting: EffortSetting, model: string): ResolvedEffort {
  if (setting === "off") return { effort: null, clamped: false, unsupported: false };
  const supported = effortSupport(model);
  if (supported.length === 0) return { effort: null, clamped: false, unsupported: true };
  if ((supported as readonly string[]).includes(setting)) {
    return { effort: setting, clamped: false, unsupported: false };
  }
  return { effort: clampEffort(setting, supported), clamped: true, unsupported: false };
}

/**
 * Sets `output_config.effort` on a parsed /v1/messages body according to the
 * setting and the body's own `model` — a no-op when the field must not be
 * sent. Wire shape verified against captured CC 2.1.300 traffic
 * (re/notes/cc-capture.jsonl): effort rides INSIDE `output_config`, never as
 * a top-level field (a top-level `effort` is rejected with "Extra inputs are
 * not permitted"), and the effort-2025-11-24 beta header travels alongside
 * (provider.ts). The provider-layer counterpart of applyCacheBreakpoints.
 * A value already in the body (a proxied client's own choice) is returned
 * untouched — the client's intent always wins over the server default.
 * Returns the value that was set, or null when the field stays absent.
 */
export function applyEffortToBody(body: any, setting: EffortSetting): Effort | null {
  if (typeof body?.output_config?.effort === "string") return body.output_config.effort as Effort;
  const resolved = resolveEffort(setting, String(body?.model ?? ""));
  if (!resolved.effort) return null;
  body.output_config = { ...(body.output_config ?? {}), effort: resolved.effort };
  return resolved.effort;
}

// ------------------------------------------------- process-wide session state

let sessionOverride: EffortSetting | null = null;

/**
 * REPL override (/effort): wins over WRONGFORGE_EFFORT for this process.
 * `null` clears it back to the env default.
 */
export function setSessionEffort(e: EffortSetting | null): void {
  sessionOverride = e;
}

export function sessionEffort(): EffortSetting | null {
  return sessionOverride;
}

let effortRejectedAll = false;
const rejectedModels = new Set<string>();

// ------------------------------------------------------- learned effort caps
// Claude Code 2.1.314's changelog reveals a second effort-refusal shape: an
// organization admin can CAP a model's effort, and the backend answers
// "Invalid effort level" — the parameter itself is fine, the level is above
// the account's ceiling. CC's own fix steps the effort DOWN and retries
// instead of dropping the field; caps learn the working level per model the
// same way (and persist like rejections), so future requests clamp directly.

/** The next level strictly below `level`; null when already at the bottom. */
export function lowerEffort(level: Effort): Effort | null {
  const i = EFFORTS.indexOf(level);
  return i > 0 ? EFFORTS[i - 1]! : null;
}

const cappedModels = new Map<string, Effort>();

/** The learned ceiling for a model, or null when none was learned. */
export function effortCap(model?: string): Effort | null {
  if (!model) return null;
  return cappedModels.get(model) ?? null;
}

/**
 * Records that `model`'s account accepts at most `level` (as learned from an
 * "Invalid effort level" refusal). `effectiveEffort` then clamps every
 * request for that model down to the cap. Remembered across restarts
 * (7 days) when initEffortPersistence has wired a file.
 */
export function noteEffortCap(model: string, level: Effort): void {
  cappedModels.set(model, level);
  persistRejections();
}

// ------------------------------------------------------- learned rejections
// What the API refuses is remembered on disk too, so a serve restart does not
// re-pay the probe (one failed request + retry) for every already-known model.
// Entries expire: a backend that gains effort support is picked up again.

/** How long a learned rejection is trusted (default: a week). */
const REJECTION_TTL_MS = 7 * 24 * 3600 * 1000;
const GLOBAL_KEY = "*";

let rejectionFile: string | null = null;

/**
 * Wires the learned-rejection cache to a file and loads it (createApp does
 * this with <home>/effort-rejections.json). Without a call, the cache stays
 * process-local — that is what library users and the unit tests get, so
 * nothing ever writes to a real data directory from a test process.
 */
export function initEffortPersistence(file?: string): void {
  rejectionFile = file ?? null;
  effortRejectedAll = false;
  rejectedModels.clear();
  cappedModels.clear();
  if (!rejectionFile) return;
  try {
    const doc = JSON.parse(fs.readFileSync(rejectionFile, "utf8")) as {
      rejected?: Record<string, unknown>;
      caps?: Record<string, unknown>;
    };
    const now = Date.now();
    for (const [model, ts] of Object.entries(doc.rejected ?? {})) {
      if (typeof ts !== "number" || now - ts > REJECTION_TTL_MS) continue;
      if (model === GLOBAL_KEY) effortRejectedAll = true;
      else rejectedModels.add(model);
    }
    for (const [model, level] of Object.entries(doc.caps ?? {})) {
      if (isEffort(level)) cappedModels.set(model, level);
    }
  } catch {
    /* absent or unreadable — start empty */
  }
}

function persistRejections(): void {
  if (!rejectionFile) return;
  const rejected: Record<string, number> = {};
  for (const m of rejectedModels) rejected[m] = Date.now();
  if (effortRejectedAll) rejected[GLOBAL_KEY] = Date.now();
  const caps: Record<string, string> = {};
  for (const [m, lvl] of cappedModels) caps[m] = lvl;
  try {
    fs.mkdirSync(path.dirname(rejectionFile), { recursive: true });
    fs.writeFileSync(rejectionFile, `${JSON.stringify({ version: 2, rejected, caps }, null, 2)}\n`);
  } catch {
    /* read-only data dir — stay memory-only */
  }
}

/**
 * Set by provider.ts when the API refused the `effort` field. With a model id
 * only THAT model loses effort (others keep theirs — a capable model must not
 * be punished for an incapable one); without one (unparseable body) the whole
 * process opts out. Remembered across restarts (7 days) when
 * initEffortPersistence has wired a file.
 */
export function markEffortRejected(model?: string): void {
  if (model) rejectedModels.add(model);
  else effortRejectedAll = true;
  persistRejections();
}

export function effortRejectedOnce(model?: string): boolean {
  return effortRejectedAll || (model !== undefined && rejectedModels.has(model));
}

/** Test isolation: forget the learned rejections and caps. */
export function resetEffortRejections(): void {
  effortRejectedAll = false;
  rejectedModels.clear();
  cappedModels.clear();
}

/**
 * The effort setting that applies to a request being built right now:
 * task override (context) > REPL /effort override > env default;
 * "off" for models the API has already refused the parameter for; a level
 * clamped down to the learned account cap when the model has one (an
 * org-admin effort cap — "Invalid effort level", see noteEffortCap).
 */
export function effectiveEffort(model: string, env: NodeJS.ProcessEnv = process.env): EffortSetting {
  if (effortRejectedOnce(model)) return "off";
  const setting = currentContext()?.effort ?? sessionEffort() ?? defaultEffort(env);
  const cap = cappedModels.get(model);
  if (setting !== "off" && cap && RANK[setting] > RANK[cap]) return cap;
  return setting;
}
