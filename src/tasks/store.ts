/**
 * Durable task storage.
 *
 *   <dir>/<task_id>/task.json          TaskRecord (atomic write: tmp + rename)
 *   <dir>/<task_id>/events.jsonl       one TaskEvent per line, append-only
 *   <dir>/<task_id>/events.jsonl.gz    the same, after `maintain` compressed it
 *
 * All records are kept in memory too (loaded at startup); the files are the
 * source of truth across restarts and the replay source for the events API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { gzipFile } from "../log.js";
import { SESSION_ID_RE } from "../sessions.js";
import { isTerminal, type TaskEvent, type TaskRecord, type TaskStatus } from "./types.js";

const DAY_MS = 86_400_000;

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  session_id?: string;
  /** Only tasks of this client (absent or "default" = no scoping — the default key sees every client). */
  client?: string;
  /** Only tasks created before this ISO timestamp (pagination cursor). */
  before?: string;
  limit?: number;
}

export interface TaskMaintainResult {
  compressed: string[];
  deleted: string[];
  errors: { task_id: string; error: string }[];
}

export class TaskStore {
  private records = new Map<string, TaskRecord>();

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.loadAll();
  }

  static isValidId(id: unknown): id is string {
    return typeof id === "string" && SESSION_ID_RE.test(id);
  }

  private tdir(id: string): string {
    if (!TaskStore.isValidId(id)) throw new Error(`invalid task id: ${String(id)}`);
    return path.join(this.dir, id);
  }

  private loadAll(): void {
    for (const name of fs.readdirSync(this.dir)) {
      if (!TaskStore.isValidId(name)) continue;
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(this.dir, name, "task.json"), "utf8")) as TaskRecord;
        if (rec?.id === name) this.records.set(name, rec);
      } catch {
        /* unreadable task dir: ignore */
      }
    }
  }

  has(id: string): boolean {
    return this.records.has(id);
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  /** Inserts or updates a record and persists it atomically. */
  put(rec: TaskRecord): void {
    const d = this.tdir(rec.id);
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, "task.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fs.renameSync(tmp, file);
    this.records.set(rec.id, rec);
  }

  /** Newest first. */
  list(filter: TaskFilter = {}): TaskRecord[] {
    const statuses = filter.status === undefined ? null : new Set([filter.status].flat());
    let out = [...this.records.values()];
    if (statuses) out = out.filter((r) => statuses.has(r.status));
    if (filter.session_id) out = out.filter((r) => r.session_id === filter.session_id);
    if (filter.client) out = out.filter((r) => (r.client ?? "default") === filter.client);
    if (filter.before) out = out.filter((r) => r.created_at < filter.before!);
    out.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return out.slice(0, filter.limit ?? 100);
  }

  appendEvent(ev: TaskEvent): void {
    fs.appendFileSync(path.join(this.tdir(ev.task_id), "events.jsonl"), JSON.stringify(ev) + "\n");
  }

  /** Events with seq > `after`, in order (reads compressed logs too). */
  readEvents(id: string, after = 0, limit = 1000): TaskEvent[] {
    if (!this.records.has(id)) return [];
    const d = this.tdir(id);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(d, "events.jsonl"), "utf8");
    } catch {
      try {
        raw = gunzipSync(fs.readFileSync(path.join(d, "events.jsonl.gz"))).toString("utf8");
      } catch {
        return [];
      }
    }
    const out: TaskEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let ev: TaskEvent;
      try {
        ev = JSON.parse(line) as TaskEvent;
      } catch {
        break; // torn last line after a crash
      }
      if (ev.seq > after) {
        out.push(ev);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  /** Highest seq stored for a task (0 if none) — used when resuming after a restart. */
  lastSeq(id: string): number {
    const evs = this.readEvents(id, 0, Number.MAX_SAFE_INTEGER);
    return evs.length ? evs[evs.length - 1]!.seq : 0;
  }

  delete(id: string): boolean {
    if (!this.records.has(id)) return false;
    fs.rmSync(this.tdir(id), { recursive: true, force: true });
    this.records.delete(id);
    return true;
  }

  /**
   * Housekeeping for FINISHED tasks (live ones are never touched):
   *  - finished more than `compressAfterDays` ago -> events.jsonl is gzipped
   *  - finished more than `deleteAfterDays` ago   -> the whole task is deleted
   * A value of 0 disables that step.
   */
  async maintain(opts: {
    compressAfterDays: number;
    deleteAfterDays: number;
    now?: () => Date;
  }): Promise<TaskMaintainResult> {
    const res: TaskMaintainResult = { compressed: [], deleted: [], errors: [] };
    const nowMs = (opts.now ?? (() => new Date()))().getTime();
    for (const rec of [...this.records.values()]) {
      if (!isTerminal(rec.status) || !rec.finished_at) continue;
      const age = nowMs - Date.parse(rec.finished_at);
      try {
        if (opts.deleteAfterDays > 0 && age > opts.deleteAfterDays * DAY_MS) {
          this.delete(rec.id);
          res.deleted.push(rec.id);
        } else if (opts.compressAfterDays > 0 && age > opts.compressAfterDays * DAY_MS) {
          const ev = path.join(this.tdir(rec.id), "events.jsonl");
          if (fs.existsSync(ev)) {
            await gzipFile(ev);
            res.compressed.push(rec.id);
          }
        }
      } catch (e) {
        res.errors.push({ task_id: rec.id, error: (e as Error).message });
      }
    }
    return res;
  }
}
