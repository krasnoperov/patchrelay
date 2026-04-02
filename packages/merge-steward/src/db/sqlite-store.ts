import type { QueueStore } from "../store.ts";
import type {
  QueueEntry,
  QueueEntryStatus,
  QueueEventRecord,
  QueueEventSummary,
  IncidentRecord,
  EvictionContext,
} from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";
import type { DatabaseConnection } from "./shared.ts";
import { SqliteConnection, isoNow } from "./shared.ts";
import { ensureSchema } from "./schema.ts";

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
    retryAttempts: Number(row.retry_attempts),
    maxRetries: Number(row.max_retries),
    lastFailedBaseSha: row.last_failed_base_sha === null ? null : String(row.last_failed_base_sha),
    issueKey: row.issue_key === null ? null : String(row.issue_key),
    specBranch: row.spec_branch === null || row.spec_branch === undefined ? null : String(row.spec_branch),
    specSha: row.spec_sha === null || row.spec_sha === undefined ? null : String(row.spec_sha),
    specBasedOn: row.spec_based_on === null || row.spec_based_on === undefined ? null : String(row.spec_based_on),
    enqueuedAt: String(row.enqueued_at),
    updatedAt: String(row.updated_at),
  };
}

function mapIncident(row: Record<string, unknown>): IncidentRecord {
  return {
    id: String(row.id),
    entryId: String(row.entry_id),
    at: String(row.at),
    failureClass: String(row.failure_class) as IncidentRecord["failureClass"],
    context: JSON.parse(String(row.context_json)) as EvictionContext,
    outcome: String(row.outcome) as IncidentRecord["outcome"],
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
    baseSha: row.base_sha === null || row.base_sha === undefined ? undefined : String(row.base_sha),
  };
}

function mapEventSummary(row: Record<string, unknown>): QueueEventSummary {
  return {
    id: Number(row.id),
    entryId: String(row.entry_id),
    at: String(row.at),
    fromStatus: row.from_status === null ? null : (String(row.from_status) as QueueEntryStatus),
    toStatus: String(row.to_status) as QueueEntryStatus,
    detail: row.detail === null ? undefined : String(row.detail),
    baseSha: row.base_sha === null || row.base_sha === undefined ? undefined : String(row.base_sha),
    prNumber: Number(row.pr_number),
    branch: String(row.branch),
    issueKey: row.issue_key === null ? null : String(row.issue_key),
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
    ensureSchema(this.conn);
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
       ORDER BY position ASC
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
          priority, generation, ci_run_id, ci_retries, retry_attempts,
          max_retries, last_failed_base_sha, issue_key, enqueued_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.id, entry.repoId, entry.prNumber, entry.branch,
        entry.headSha, entry.baseSha, entry.status, entry.position,
        entry.priority, entry.generation, entry.ciRunId, entry.ciRetries,
        entry.retryAttempts, entry.maxRetries, entry.lastFailedBaseSha,
        entry.issueKey, entry.enqueuedAt, entry.updatedAt,
      );
      this.writeEvent(entry.id, null, entry.status);
    })();
  }

  transition(
    entryId: string,
    to: QueueEntryStatus,
    patch?: Partial<Pick<QueueEntry, "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "retryAttempts" | "lastFailedBaseSha" | "specBranch" | "specSha" | "specBasedOn">>,
    detail?: string,
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
      if (patch?.retryAttempts !== undefined) { sets.push("retry_attempts = ?"); values.push(patch.retryAttempts); }
      if (patch?.lastFailedBaseSha !== undefined) { sets.push("last_failed_base_sha = ?"); values.push(patch.lastFailedBaseSha); }
      if (patch?.specBranch !== undefined) { sets.push("spec_branch = ?"); values.push(patch.specBranch); }
      if (patch?.specSha !== undefined) { sets.push("spec_sha = ?"); values.push(patch.specSha); }
      if (patch?.specBasedOn !== undefined) { sets.push("spec_based_on = ?"); values.push(patch.specBasedOn); }

      this.conn.prepare(
        `UPDATE queue_entries SET ${sets.join(", ")} WHERE id = ?`,
      ).run(...values, entryId);
      this.writeEvent(entryId, from, to, detail);
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
          ci_run_id = NULL, ci_retries = 0, retry_attempts = 0,
          last_failed_base_sha = NULL,
          spec_branch = NULL, spec_sha = NULL, spec_based_on = NULL,
          updated_at = ?
         WHERE id = ?`,
      ).run(newHeadSha, newGen, isoNow(), entryId);

      this.writeEvent(entryId, from, "queued", `updateHead: generation ${newGen}`);
    })();
  }

  insertIncident(incident: IncidentRecord): void {
    this.conn.prepare(
      `INSERT INTO queue_incidents (id, entry_id, at, failure_class, context_json, outcome)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      incident.id, incident.entryId, incident.at,
      incident.failureClass, JSON.stringify(incident.context), incident.outcome,
    );
  }

  listIncidents(entryId: string): IncidentRecord[] {
    const rows = this.conn.prepare(
      "SELECT * FROM queue_incidents WHERE entry_id = ? ORDER BY at ASC",
    ).all(entryId);
    return rows.map(mapIncident);
  }

  getIncident(incidentId: string): IncidentRecord | undefined {
    const row = this.conn.prepare(
      "SELECT * FROM queue_incidents WHERE id = ?",
    ).get(incidentId);
    return row ? mapIncident(row) : undefined;
  }

  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[] {
    const limit = opts?.limit ?? 1000;
    const rows = this.conn.prepare(
      `SELECT * FROM (
         SELECT * FROM queue_events
         WHERE entry_id = ?
         ORDER BY id DESC
         LIMIT ?
       )
       ORDER BY id ASC`,
    ).all(entryId, limit);
    return rows.map(mapEvent);
  }

  listRecentEvents(repoId: string, opts?: { limit?: number }): QueueEventSummary[] {
    const limit = opts?.limit ?? 100;
    const rows = this.conn.prepare(
      `SELECT
         queue_events.id,
         queue_events.entry_id,
         queue_events.at,
         queue_events.from_status,
         queue_events.to_status,
         queue_events.detail,
         queue_events.base_sha,
         queue_entries.pr_number,
         queue_entries.branch,
         queue_entries.issue_key
       FROM queue_events
       INNER JOIN queue_entries ON queue_entries.id = queue_events.entry_id
       WHERE queue_entries.repo_id = ?
       ORDER BY queue_events.id DESC
       LIMIT ?`,
    ).all(repoId, limit);
    return rows.reverse().map(mapEventSummary);
  }

  private writeEvent(
    entryId: string,
    fromStatus: QueueEntryStatus | null,
    toStatus: QueueEntryStatus,
    detail?: string,
  ): void {
    const entry = this.conn.prepare("SELECT base_sha FROM queue_entries WHERE id = ?").get(entryId);
    const baseSha = entry ? (entry.base_sha as string) || null : null;
    this.conn.prepare(
      `INSERT INTO queue_events (entry_id, at, from_status, to_status, detail, base_sha)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(entryId, isoNow(), fromStatus, toStatus, detail ?? null, baseSha);
  }
}
