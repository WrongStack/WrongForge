/**
 * OAuth client configuration.
 *
 * No identifiers are hardcoded in the code. The client ID is a public
 * application-registration value (the same for every install of the app it
 * belongs to — it is not tied to you or your machine), but per project policy
 * it is supplied externally:
 *
 *   1. CLAUDE_OAUTH_CLIENT_ID / CLAUDE_OAUTH_AUTHORIZE_URL / … env vars, or
 *   2. a JSON file at CLAUDE_OAUTH_CONFIG or ~/.wrongforge/oauth.json
 *      (create it from oauth.config.example.json — `npm run config:init`).
 *
 * Endpoint URLs and the scope have neutral defaults; only the client ID is
 * mandatory.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "./paths.js";

export interface OAuthConfig {
  clientId: string;
  authorizeUrl: string;
  tokenUrl: string;
  redirectUri: string;
  scope: string;
}

export function configFilePath(): string {
  return (
    process.env.CLAUDE_OAUTH_CONFIG ??
    path.join(dataDir(), "oauth.json")
  );
}

/** Returns null when the client ID is not configured (yet). */
export function loadOAuthConfig(): OAuthConfig | null {
  let fileCfg: Partial<OAuthConfig> = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configFilePath(), "utf8"));
  } catch {
    /* optional */
  }

  const clientId = process.env.CLAUDE_OAUTH_CLIENT_ID ?? fileCfg.clientId;
  if (!clientId) return null;

  const cfg: OAuthConfig = {
    clientId,
    // Claude Code's own production endpoints (carved from CC 2.1.300,
    // re/notes/findings.md §11): the old console.anthropic.com token URL now
    // answers 404 — platform.claude.com is the live host.
    authorizeUrl:
      process.env.ANTHROPIC_AUTHORIZE_URL ??
      process.env.CLAUDE_OAUTH_AUTHORIZE_URL ??
      fileCfg.authorizeUrl ??
      "https://platform.claude.com/oauth/authorize",
    tokenUrl:
      process.env.ANTHROPIC_TOKEN_URL ??
      process.env.CLAUDE_OAUTH_TOKEN_URL ??
      fileCfg.tokenUrl ??
      "https://platform.claude.com/v1/oauth/token",
    redirectUri:
      process.env.CLAUDE_OAUTH_REDIRECT_URI ??
      fileCfg.redirectUri ??
      "https://platform.claude.com/oauth/code/callback",
    scope:
      process.env.CLAUDE_OAUTH_SCOPE ??
      fileCfg.scope ??
      "user:inference user:profile",
  };
  return migrateStaleEndpoints(cfg, fileCfg);
}

/**
 * OAuth endpoints that died when Anthropic moved the CLI's OAuth surface to
 * platform.claude.com (probe table, re/notes/findings.md §11: the
 * console.anthropic.com token URL answers 404 not_found_error). Installs
 * that created their oauth.json before v0.4.3 still carry these values, and
 * a file value always beats the code default — every token refresh then 404s
 * and the instance limps on Claude-Code session recovery or 502s outright
 * (seen live 2026-11-22: `[auth] refresh HTTP 404` → /v1/usage
 * usage_unavailable). The mapping is exact-string and evidence-backed;
 * anything else (a custom gateway URL) is left untouched.
 */
const LEGACY_ENDPOINTS: Readonly<Record<string, string>> = {
  "https://console.anthropic.com/v1/oauth/token": "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/oauth/authorize": "https://platform.claude.com/oauth/authorize",
  "https://console.anthropic.com/oauth/code/callback": "https://platform.claude.com/oauth/code/callback",
};

type EndpointField = "authorizeUrl" | "tokenUrl" | "redirectUri";

const ENDPOINT_FIELDS: readonly EndpointField[] = ["authorizeUrl", "tokenUrl", "redirectUri"];

/** The env vars each endpoint field can come from, in precedence order. */
const ENDPOINT_ENV_VARS: Readonly<Record<EndpointField, readonly string[]>> = {
  authorizeUrl: ["ANTHROPIC_AUTHORIZE_URL", "CLAUDE_OAUTH_AUTHORIZE_URL"],
  tokenUrl: ["ANTHROPIC_TOKEN_URL", "CLAUDE_OAUTH_TOKEN_URL"],
  redirectUri: ["CLAUDE_OAUTH_REDIRECT_URI"],
};

/** Stale env overrides already reported by this process. */
const reportedMigrations = new Set<string>();

/** Set once an in-place oauth.json rewrite failed (see migrateStaleEndpoints). */
let fileRewriteFailed = false;

/**
 * Replace dead legacy endpoints with the live defaults and heal the source:
 * a stale value in oauth.json is rewritten in place (only the stale fields —
 * other keys, including a custom clientId, are preserved); a stale env var is
 * overridden for this process with a warning naming the variable, so an
 * operator sees which knob to fix. Self-heal, not silent: every migration
 * logs — once per process. The config is re-read on EVERY access
 * (ClaudeOAuth.config is a getter, not a cache), so a source this process
 * cannot heal (a stale env var, an unwritable file) would otherwise warn on
 * each read.
 */
function migrateStaleEndpoints(cfg: OAuthConfig, fileCfg: Partial<OAuthConfig>): OAuthConfig {
  const staleFile: EndpointField[] = [];
  for (const field of ENDPOINT_FIELDS) {
    const live = LEGACY_ENDPOINTS[cfg[field]];
    if (!live) continue;
    cfg[field] = live;
    const envName = ENDPOINT_ENV_VARS[field].find((n) => process.env[n]);
    if (!envName) {
      fileCfg[field] = live;
      staleFile.push(field);
    } else if (!reportedMigrations.has(envName)) {
      reportedMigrations.add(envName);
      console.warn(
        `[auth] ${envName} points at the dead ${field} — using ${live} for this run; update or unset the variable to make this permanent`,
      );
    }
  }
  // One rewrite attempt per process: after a failure the healed value is
  // still in effect here, and retrying on every config read would only repeat
  // the error. The next process to start tries again.
  if (staleFile.length && !fileRewriteFailed) {
    const file = configFilePath();
    const fields = staleFile.join(", ");
    try {
      rewriteConfigFile(file, fileCfg);
      console.warn(
        `[auth] oauth config carried the dead console.anthropic.com ${fields} — rewrote it to platform.claude.com (in effect immediately; no restart needed)`,
      );
    } catch (e) {
      fileRewriteFailed = true;
      console.warn(
        `[auth] oauth config still carries the dead console.anthropic.com ${fields} and could not be rewritten (${(e as Error).message}) — using platform.claude.com for this process; fix ${file} to make it permanent`,
      );
    }
  }
  return cfg;
}

/**
 * Atomic config rewrite: write a sibling temp file, then rename it over the
 * config. A crash or full disk mid-write must never leave the operator's
 * oauth.json truncated — a lost clientId means no OAuth at all, a worse state
 * than the dead endpoints this heals. When either step fails the original is
 * left untouched. The temp name carries the pid so two processes healing the
 * same file (a running `serve` plus a cron `wrongforge refresh`) never write
 * through the same file.
 */
function rewriteConfigFile(file: string, fileCfg: Partial<OAuthConfig>): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(fileCfg, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never created, or not a regular file */
    }
    throw e;
  }
}

export function configHelp(): string {
  return (
    "OAuth client is not configured. Either set CLAUDE_OAUTH_CLIENT_ID or run\n" +
    "`npm run config:init` to create " +
    configFilePath() +
    " from oauth.config.example.json."
  );
}
