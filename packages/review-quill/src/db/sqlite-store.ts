import { SCHEMA_SQL } from "./schema.ts";
import { SqliteConnection, isoNow } from "./shared.ts";
import type { ReviewAttemptConclusion, ReviewAttemptRecord, ReviewAttemptStatus, WebhookEventRecord } from "../types.ts";

function mapAttempt(row: Record<string, unknown>): ReviewAttemptRecord {
  return {
    id: Number(row.id),
    repoFullName: String(row.repo_full_name),
    prNumber: Number(row.pr_number),
    headSha: String(row.head_sha),
    status: String(row.status) as ReviewAttemptStatus,
    ...(row.conclusion ? { conclusion: String(row.conclusion) as ReviewAttemptConclusion } : {}),
    ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
    ...(row.external_check_run_id !== null && row.external_check_run_id !== undefined ? { externalCheckRunId: Number(row.external_check_run_id) } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
  };
}

function mapWebhook(row: Record<string, unknown>): WebhookEventRecord {
  return {
    deliveryId: String(row.delivery_id),
    eventType: String(row.event_type),
    ...(row.repo_full_name ? { repoFullName: String(row.repo_full_name) } : {}),
    receivedAt: String(row.received_at),
    ...(row.processed_at ? { processedAt: String(row.processed_at) } : {}),
    ...(row.ignored_reason ? { ignoredReason: String(row.ignored_reason) } : {}),
  };
}

export class SqliteStore {
  private readonly db: SqliteConnection;

  constructor(filePath: string) {
    this.db = new SqliteConnection(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  isWebhookDuplicate(deliveryId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS value FROM webhook_events WHERE delivery_id = ?").get(deliveryId);
    return row !== undefined;
  }

  recordWebhook(deliveryId: string, eventType: string, repoFullName?: string): void {
    this.db.prepare(`
      INSERT INTO webhook_events (delivery_id, event_type, repo_full_name, received_at)
      VALUES (?, ?, ?, ?)
    `).run(deliveryId, eventType, repoFullName ?? null, isoNow());
  }

  markWebhookProcessed(deliveryId: string, ignoredReason?: string): void {
    this.db.prepare(`
      UPDATE webhook_events
      SET processed_at = ?, ignored_reason = ?
      WHERE delivery_id = ?
    `).run(isoNow(), ignoredReason ?? null, deliveryId);
  }

  getAttempt(repoFullName: string, prNumber: number, headSha: string): ReviewAttemptRecord | undefined {
    const row = this.db.prepare(`
      SELECT *
      FROM review_attempts
      WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?
    `).get(repoFullName, prNumber, headSha);
    return row ? mapAttempt(row) : undefined;
  }

  getAttemptById(id: number): ReviewAttemptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM review_attempts WHERE id = ?").get(id);
    return row ? mapAttempt(row) : undefined;
  }

  createAttempt(params: {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    status: ReviewAttemptStatus;
  }): ReviewAttemptRecord {
    const now = isoNow();
    const result = this.db.prepare(`
      INSERT INTO review_attempts (
        repo_full_name, pr_number, head_sha, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(params.repoFullName, params.prNumber, params.headSha, params.status, now, now);
    return this.getAttemptById(Number(result.lastInsertRowid))!;
  }

  updateAttempt(id: number, params: {
    status?: ReviewAttemptStatus;
    conclusion?: ReviewAttemptConclusion;
    summary?: string;
    threadId?: string;
    turnId?: string;
    externalCheckRunId?: number;
    completedAt?: string | null;
  }): ReviewAttemptRecord | undefined {
    const sets: string[] = ["updated_at = @updatedAt"];
    const values: Record<string, unknown> = { id, updatedAt: isoNow() };
    if (params.status !== undefined) {
      sets.push("status = @status");
      values.status = params.status;
    }
    if (params.conclusion !== undefined) {
      sets.push("conclusion = @conclusion");
      values.conclusion = params.conclusion;
    }
    if (params.summary !== undefined) {
      sets.push("summary = @summary");
      values.summary = params.summary;
    }
    if (params.threadId !== undefined) {
      sets.push("thread_id = @threadId");
      values.threadId = params.threadId;
    }
    if (params.turnId !== undefined) {
      sets.push("turn_id = @turnId");
      values.turnId = params.turnId;
    }
    if (params.externalCheckRunId !== undefined) {
      sets.push("external_check_run_id = @externalCheckRunId");
      values.externalCheckRunId = params.externalCheckRunId;
    }
    if (params.completedAt !== undefined) {
      sets.push("completed_at = @completedAt");
      values.completedAt = params.completedAt;
    }
    this.db.prepare(`UPDATE review_attempts SET ${sets.join(", ")} WHERE id = @id`).run(values);
    return this.getAttemptById(id);
  }

  listAttempts(limit = 100): ReviewAttemptRecord[] {
    return this.db.prepare(`
      SELECT *
      FROM review_attempts
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).map(mapAttempt);
  }

  listAttemptsForPullRequest(repoFullName: string, prNumber: number, limit = 20): ReviewAttemptRecord[] {
    return this.db.prepare(`
      SELECT *
      FROM review_attempts
      WHERE repo_full_name = ? AND pr_number = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(repoFullName, prNumber, limit).map(mapAttempt);
  }

  listWebhooks(limit = 50): WebhookEventRecord[] {
    return this.db.prepare(`
      SELECT *
      FROM webhook_events
      ORDER BY received_at DESC
      LIMIT ?
    `).all(limit).map(mapWebhook);
  }
}
