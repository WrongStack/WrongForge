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

/** The env vars each endpoint field can come from, in precedence order. */
const ENDPOINT_ENV_VARS: Readonly<Record<"authorizeUrl" | "tokenUrl" | "redirectUri", readonly string[]>> = {
  authorizeUrl: ["ANTHROPIC_AUTHORIZE_URL", "CLAUDE_OAUTH_AUTHORIZE_URL"],
  tokenUrl: ["ANTHROPIC_TOKEN_URL", "CLAUDE_OAUTH_TOKEN_URL"],
  redirectUri: ["CLAUDE_OAUTH_REDIRECT_URI"],
};

/**
 * Replace dead legacy endpoints with the live defaults and heal the source:
 * a stale value in oauth.json is rewritten in place (only the stale fields —
 * other keys, including a custom clientId, are preserved); a stale env var is
 * overridden for this process with a warning naming the variable, so an
 * operator sees which knob to fix. Self-heal, not silent: every migration
 * logs.
 */
function migrateStaleEndpoints(cfg: OAuthConfig, fileCfg: Partial<OAuthConfig>): OAuthConfig {
  let fileDirty = false;
  for (const field of ["authorizeUrl", "tokenUrl", "redirectUri"] as const) {
    const live = LEGACY_ENDPOINTS[cfg[field]];
    if (!live) continue;
    cfg[field] = live;
    const envName = ENDPOINT_ENV_VARS[field].find((n) => process.env[n]);
    if (envName) {
      console.warn(
        `[auth] ${envName} points at the dead ${field} — using ${live} for this run; update or unset the variable to make this permanent`,
      );
    } else {
      fileCfg[field] = live;
      fileDirty = true;
      console.warn(
        `[auth] oauth config carried the dead console.anthropic.com ${field} — rewrote it to ${live}; restart \`serve\` to pick it up`,
      );
    }
  }
  if (fileDirty) {
    try {
      fs.writeFileSync(configFilePath(), JSON.stringify(fileCfg, null, 2) + "\n");
    } catch (e) {
      console.warn(
        `[auth] could not rewrite ${configFilePath()} (${(e as Error).message}) — update the dead endpoint values manually`,
      );
    }
  }
  return cfg;
}

export function configHelp(): string {
  return (
    "OAuth client is not configured. Either set CLAUDE_OAUTH_CLIENT_ID or run\n" +
    "`npm run config:init` to create " +
    configFilePath() +
    " from oauth.config.example.json."
  );
}
