/**
 * Append-only audit trail for the multi-tenant surfaces.
 *
 * One JSON line per user-driven mutation — who (client key identity) did
 * what (action) to what (target) — recorded at the ROUTE layer so internal
 * actions (timeouts, restarts, client-disconnect cancels) never masquerade
 * as client intent. Prompts and secrets are never written here: detail
 * fields carry identifiers and short reasons only.
 *
 * The file is plain append (audit.jsonl in the data dir); it grows slowly
 * (one line per mutation) and is deliberately not rotated — keep-a-forever
 * is the point of an audit trail. Reading back is admin-only (GET /v1/audit).
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface AuditEntry {
  ts: string;
  client: string;
  action: string;
  target: string;
  detail?: Record<string, unknown>;
}

export class AuditLog {
  constructor(private readonly file: string | null) {}

  /** Appends one entry; a write failure never breaks the API action itself. */
  record(client: string, action: string, target: string, detail?: Record<string, unknown>): void {
    if (!this.file) return;
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      client,
      action,
      target,
      ...(detail && Object.keys(detail).length ? { detail } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    } catch {
      /* read-only data dir — the audit is best-effort by design */
    }
  }

  /** Newest-first tail (admin read path). */
  tail(limit = 200): AuditEntry[] {
    if (!this.file) return [];
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, "utf8");
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (typeof e?.ts === "string" && typeof e?.action === "string") out.push(e);
      } catch {
        /* skip a torn/invalid line */
      }
    }
    return out.reverse().slice(0, Math.max(1, limit));
  }
}
