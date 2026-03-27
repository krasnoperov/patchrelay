import type { QueueStore } from "../store.ts";
import type {
  QueueEntry,
  QueueEntryStatus,
  QueueEventRecord,
  RepairRequestRecord,
} from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";
import type { DatabaseConnection } from "./shared.ts";
import { SqliteConnection, isoNow } from "./shared.ts";
import { runMigrations } from "./migrations.ts";

function mapEntry(row: Record<string, unknown>): QueueEntry {
  return {
    id: String(row.id),
    repoId: String(row.repo_id),
    prNumber: Number(row.pr_number),
    branch: String(row.branch),
    headSha: String(row.head_sha),
    baseSha: String(row.base_sha),
    status: String(row.status) as QueueEntryStatus,
    position: Number(row.position),
    priority: Number(row.priority),
    generation: Number(row.generation),
    ciRunId: row.ci_run_id === null ? null : String(row.ci_run_id),
    ciRetries: Number(row.ci_retries),
    repairAttempts: Number(row.repair_attempts),
    maxRepairAttempts: Number(row.max_repair_attempts),
    issueKey: row.issue_key === null ? null : String(row.issue_key),
    worktreePath: row.worktree_path === null ? null : String(row.worktree_path),
    enqueuedAt: String(row.enqueued_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRepairRequest(row: Record<string, unknown>): RepairRequestRecord {
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    at: String(row.at),
    kind: String(row.kind) as RepairRequestRecord["kind"],
    failureClass: String(row.failure_class) as RepairRequestRecord["failureClass"],
    summary: row.summary === null ? undefined : String(row.summary),
    outcome: String(row.outcome) as RepairRequestRecord["outcome"],
  };
}

function mapEvent(row: Record<string, unknown>): QueueEventRecord {
  return {
    id: Number(row.id),
    entryId: String(row.entry_id),
    at: String(row.at),
    fromStatus: row.from_status === null ? null : (String(row.from_status) as QueueEntryStatus),
    toStatus: String(row.to_status) as QueueEntryStatus,
    detail: row.detail === null ? undefined : String(row.detail),
  };
}

const NOT_TERMINAL_SQL = TERMINAL_STATUSES.map(() => "?").join(", ");

export class SqliteStore implements QueueStore {
  private readonly conn: DatabaseConnection;
  private readonly ownsConnection: boolean;

  constructor(pathOrConnection: string | DatabaseConnection) {
    if (typeof pathOrConnection === "string") {
      const conn = new SqliteConnection(pathOrConnection);
      conn.pragma("foreign_keys = ON");
      conn.pragma("journal_mode = WAL");
      this.conn = conn;
      this.ownsConnection = true;
    } else {
      this.conn = pathOrConnection;
      this.ownsConnection = false;
    }
    runMigrations(this.conn);
  }

  close(): void {
    if (this.ownsConnection) {
      this.conn.close();
    }
  }

  getHead(repoId: string): QueueEntry | undefined {
    const row = this.conn.prepare(
      `SELECT * FROM queue_entries
       WHERE repo_id = ? AND status NOT IN (${NOT_TERMINAL_SQL})
       ORDER BY position ASC LIMIT 1`,
    ).get(repoId, ...TERMINAL_STATUSES);
    return row ? mapEntry(row) : undefined;
  }

  getEntry(entryId: string): QueueEntry | undefined {
    const row = this.conn.prepare(
      "SELECT * FROM queue_entries WHERE id = ?",
    ).get(entryId);
    return row ? mapEntry(row) : undefined;
  }

  getEntryByPR(repoId: string, prNumber: number): QueueEntry | undefined {
    const row = this.conn.prepare(
      `SELECT * FROM queue_entries
       WHERE repo_id = ? AND pr_number = ? AND status NOT IN (${NOT_TERMINAL_SQL})
       LIMIT 1`,
    ).get(repoId, prNumber, ...TERMINAL_STATUSES);
    return row ? mapEntry(row) : undefined;
  }

  listActive(repoId: string): QueueEntry[] {
    const rows = this.conn.prepare(
      `SELECT * FROM queue_entries
       WHERE repo_id = ? AND status NOT IN (${NOT_TERMINAL_SQL})
       ORDER BY position ASC`,
    ).all(repoId, ...TERMINAL_STATUSES);
    return rows.map(mapEntry);
  }

  listAll(repoId: string): QueueEntry[] {
    const rows = this.conn.prepare(
      "SELECT * FROM queue_entries WHERE repo_id = ? ORDER BY position ASC",
    ).all(repoId);
    return rows.map(mapEntry);
  }

  insert(entry: QueueEntry): void {
    this.conn.transaction(() => {
      this.conn.prepare(
        `INSERT INTO queue_entries
         (id, repo_id, pr_number, branch, head_sha, base_sha, status, position,
          priority, generation, ci_run_id, ci_retries, repair_attempts,
          max_repair_attempts, issue_key, worktree_path, enqueued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.id, entry.repoId, entry.prNumber, entry.branch,
        entry.headSha, entry.baseSha, entry.status, entry.position,
        entry.priority, entry.generation, entry.ciRunId, entry.ciRetries,
        entry.repairAttempts, entry.maxRepairAttempts, entry.issueKey,
        entry.worktreePath, entry.enqueuedAt, entry.updatedAt,
      );
      this.writeEvent(entry.id, null, entry.status);
    })();
  }

  transition(
    entryId: string,
    to: QueueEntryStatus,
    patch?: Partial<Pick<QueueEntry, "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "repairAttempts">>,
  ): void {
    this.conn.transaction(() => {
      const current = this.conn.prepare("SELECT status FROM queue_entries WHERE id = ?").get(entryId);
      if (!current) return;
      const from = String(current.status) as QueueEntryStatus;

      const sets: string[] = ["status = ?", "updated_at = ?"];
      const values: unknown[] = [to, isoNow()];
      if (patch?.headSha !== undefined) { sets.push("head_sha = ?"); values.push(patch.headSha); }
      if (patch?.baseSha !== undefined) { sets.push("base_sha = ?"); values.push(patch.baseSha); }
      if (patch?.ciRunId !== undefined) { sets.push("ci_run_id = ?"); values.push(patch.ciRunId); }
      if (patch?.ciRetries !== undefined) { sets.push("ci_retries = ?"); values.push(patch.ciRetries); }
      if (patch?.repairAttempts !== undefined) { sets.push("repair_attempts = ?"); values.push(patch.repairAttempts); }

      this.conn.prepare(
        `UPDATE queue_entries SET ${sets.join(", ")} WHERE id = ?`,
      ).run(...values, entryId);
      this.writeEvent(entryId, from, to);
    })();
  }

  dequeue(entryId: string): void {
    this.transition(entryId, "dequeued");
  }

  updateHead(entryId: string, newHeadSha: string): void {
    this.conn.transaction(() => {
      const current = this.conn.prepare("SELECT status, generation FROM queue_entries WHERE id = ?").get(entryId);
      if (!current) return;
      const from = String(current.status) as QueueEntryStatus;
      if (TERMINAL_STATUSES.includes(from)) return;
      const newGen = Number(current.generation) + 1;

      this.conn.prepare(
        `UPDATE queue_entries SET
          head_sha = ?, status = 'queued', generation = ?,
          ci_run_id = NULL, ci_retries = 0, repair_attempts = 0,
          updated_at = ?
         WHERE id = ?`,
      ).run(newHeadSha, newGen, isoNow(), entryId);

      // Abandon pending repair requests.
      this.conn.prepare(
        `UPDATE repair_requests SET outcome = 'abandoned', updated_at = ?
         WHERE entry_id = ? AND outcome = 'pending'`,
      ).run(isoNow(), entryId);

      this.writeEvent(entryId, from, "queued", `updateHead: generation ${newGen}`);
    })();
  }

  insertRepairRequest(req: RepairRequestRecord): void {
    this.conn.prepare(
      `INSERT INTO repair_requests (id, entry_id, at, kind, failure_class, summary, outcome, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(req.id, req.entryId, req.at, req.kind, req.failureClass, req.summary ?? null, req.outcome, isoNow());
  }

  listRepairRequests(entryId: string): RepairRequestRecord[] {
    const rows = this.conn.prepare(
      "SELECT * FROM repair_requests WHERE entry_id = ? ORDER BY at ASC",
    ).all(entryId);
    return rows.map(mapRepairRequest);
  }

  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.conn.prepare(
      "SELECT * FROM queue_events WHERE entry_id = ? ORDER BY id ASC LIMIT ?",
    ).all(entryId, limit);
    return rows.map(mapEvent);
  }

  private writeEvent(
    entryId: string,
    fromStatus: QueueEntryStatus | null,
    toStatus: QueueEntryStatus,
    detail?: string,
  ): void {
    this.conn.prepare(
      `INSERT INTO queue_events (entry_id, at, from_status, to_status, detail)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(entryId, isoNow(), fromStatus, toStatus, detail ?? null);
  }
}
