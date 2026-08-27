import { ensureSchema } from "./schema.ts";
import { SqliteConnection, isoNow } from "./shared.ts";
import type {
  ReviewAttemptConclusion,
  ReviewAttemptRecord,
  ReviewAttemptStatus,
  WebhookEventRecord,
} from "../types.ts";

const ATTEMPT_COLUMNS = `
  id, repo_full_name, pr_number, head_sha, status, conclusion, summary,
  pr_title, prompt_fingerprint, thread_id, turn_id, external_check_run_id,
  patch_id, pr_base_sha, base_sha,
  prior_attempt_id, review_body, review_event, publication_mode,
  created_at, updated_at, completed_at
`;

function mapAttempt(row: Record<string, unknown>): ReviewAttemptRecord {
  return {
    id: Number(row.id),
    repoFullName: String(row.repo_full_name),
    prNumber: Number(row.pr_number),
    headSha: String(row.head_sha),
    status: String(row.status) as ReviewAttemptStatus,
    ...(row.conclusion ? { conclusion: String(row.conclusion) as ReviewAttemptConclusion } : {}),
    ...(row.summary ? { summary: String(row.summary) } : {}),
    ...(row.pr_title ? { prTitle: String(row.pr_title) } : {}),
    ...(row.prompt_fingerprint ? { promptFingerprint: String(row.prompt_fingerprint) } : {}),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.turn_id ? { turnId: String(row.turn_id) } : {}),
    ...(row.external_check_run_id !== null && row.external_check_run_id !== undefined ? { externalCheckRunId: Number(row.external_check_run_id) } : {}),
    ...(row.patch_id ? { patchId: String(row.patch_id) } : {}),
    ...(row.pr_base_sha ? { prBaseSha: String(row.pr_base_sha) } : {}),
    ...(row.base_sha ? { diffBaseSha: String(row.base_sha) } : {}),
    ...(row.prior_attempt_id !== null && row.prior_attempt_id !== undefined ? { priorAttemptId: Number(row.prior_attempt_id) } : {}),
    ...(row.review_body ? { reviewBody: String(row.review_body) } : {}),
    ...(row.review_event ? { reviewEvent: String(row.review_event) as "APPROVE" | "REQUEST_CHANGES" | "COMMENT" } : {}),
    ...(row.publication_mode ? { publicationMode: String(row.publication_mode) as "body_only" } : {}),
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
    ensureSchema(this.db);
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

  pruneProcessedWebhooks(retentionDays = 7, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      DELETE FROM webhook_events
      WHERE processed_at IS NOT NULL
        AND received_at < ?
    `).run(cutoff);
    return Number(result.changes);
  }

  abandonStaleUnprocessedWebhooks(staleAfterMinutes = 15, now = new Date()): number {
    const cutoff = new Date(now.getTime() - staleAfterMinutes * 60 * 1000).toISOString();
    const result = this.db.prepare(`
      UPDATE webhook_events
      SET processed_at = ?,
          ignored_reason = 'abandoned_after_restart'
      WHERE processed_at IS NULL
        AND received_at < ?
    `).run(now.toISOString(), cutoff);
    return Number(result.changes);
  }

  getAttempt(repoFullName: string, prNumber: number, headSha: string): ReviewAttemptRecord | undefined {
    const row = this.db.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM review_attempts
      WHERE repo_full_name = ? AND pr_number = ? AND head_sha = ?
    `).get(repoFullName, prNumber, headSha);
    return row ? mapAttempt(row) : undefined;
  }

  getAttemptById(id: number): ReviewAttemptRecord | undefined {
    const row = this.db.prepare(`SELECT ${ATTEMPT_COLUMNS} FROM review_attempts WHERE id = ?`).get(id);
    return row ? mapAttempt(row) : undefined;
  }

  getLatestDifferentHeadAttempt(
    repoFullName: string,
    prNumber: number,
    headSha: string,
  ): ReviewAttemptRecord | undefined {
    const row = this.db.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM review_attempts
      WHERE repo_full_name = ? AND pr_number = ? AND head_sha <> ?
      ORDER BY id DESC
      LIMIT 1
    `).get(repoFullName, prNumber, headSha) as Record<string, unknown> | undefined;
    return row ? mapAttempt(row) : undefined;
  }

  // Finds an approved attempt with the same patch-id (any prior head) that
  // has a stored body+event we can re-emit on the new head SHA.
  findApprovedAttemptByPatchId(
    repoFullName: string,
    prNumber: number,
    patchId: string,
    diffBaseSha: string,
    promptFingerprint?: string,
  ): ReviewAttemptRecord | undefined {
    const promptFilter = promptFingerprint ? "AND prompt_fingerprint = ?" : "";
    const bindings = [
      repoFullName,
      prNumber,
      patchId,
      diffBaseSha,
      ...(promptFingerprint ? [promptFingerprint] : []),
    ];
    const row = this.db.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM review_attempts
      WHERE repo_full_name = ?
        AND pr_number = ?
        AND patch_id = ?
        AND base_sha = ?
        AND status = 'completed'
        AND conclusion = 'approved'
        AND review_body IS NOT NULL
        AND review_event IS NOT NULL
        ${promptFilter}
      ORDER BY id DESC
      LIMIT 1
    `).get(...bindings);
    return row ? mapAttempt(row) : undefined;
  }

  createAttempt(params: {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    status: ReviewAttemptStatus;
    prTitle?: string;
    promptFingerprint?: string;
    patchId?: string;
    prBaseSha?: string;
    diffBaseSha?: string;
    priorAttemptId?: number;
    reviewBody?: string;
    reviewEvent?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    publicationMode?: "body_only";
    conclusion?: ReviewAttemptConclusion;
    summary?: string;
    completedAt?: string;
  }): ReviewAttemptRecord {
    const now = isoNow();
    const result = this.db.prepare(`
      INSERT INTO review_attempts (
        repo_full_name, pr_number, head_sha, status, pr_title, prompt_fingerprint,
        patch_id, pr_base_sha, base_sha,
        prior_attempt_id, review_body, review_event, publication_mode,
        conclusion, summary, completed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?
      )
    `).run(
      params.repoFullName,
      params.prNumber,
      params.headSha,
      params.status,
      params.prTitle ?? null,
      params.promptFingerprint ?? null,
      params.patchId ?? null,
      params.prBaseSha ?? null,
      params.diffBaseSha ?? null,
      params.priorAttemptId ?? null,
      params.reviewBody ?? null,
      params.reviewEvent ?? null,
      params.publicationMode ?? null,
      params.conclusion ?? null,
      params.summary ?? null,
      params.completedAt ?? null,
      now,
      now,
    );
    return this.getAttemptById(Number(result.lastInsertRowid))!;
  }

  setAttemptTitle(id: number, prTitle: string | null): void {
    this.db.prepare("UPDATE review_attempts SET pr_title = ? WHERE id = ?").run(prTitle, id);
  }

  updateAttempt(id: number, params: {
    status?: ReviewAttemptStatus;
    conclusion?: ReviewAttemptConclusion | null;
    summary?: string;
    threadId?: string | null;
    turnId?: string | null;
    externalCheckRunId?: number | null;
    completedAt?: string | null;
    promptFingerprint?: string | null;
    patchId?: string | null;
    prBaseSha?: string | null;
    diffBaseSha?: string | null;
    priorAttemptId?: number | null;
    reviewBody?: string | null;
    reviewEvent?: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
    publicationMode?: "body_only" | null;
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
    if (params.promptFingerprint !== undefined) {
      sets.push("prompt_fingerprint = @promptFingerprint");
      values.promptFingerprint = params.promptFingerprint;
    }
    if (params.patchId !== undefined) {
      sets.push("patch_id = @patchId");
      values.patchId = params.patchId;
    }
    if (params.prBaseSha !== undefined) {
      sets.push("pr_base_sha = @prBaseSha");
      values.prBaseSha = params.prBaseSha;
    }
    if (params.diffBaseSha !== undefined) {
      sets.push("base_sha = @diffBaseSha");
      values.diffBaseSha = params.diffBaseSha;
    }
    if (params.priorAttemptId !== undefined) {
      sets.push("prior_attempt_id = @priorAttemptId");
      values.priorAttemptId = params.priorAttemptId;
    }
    if (params.reviewBody !== undefined) {
      sets.push("review_body = @reviewBody");
      values.reviewBody = params.reviewBody;
    }
    if (params.reviewEvent !== undefined) {
      sets.push("review_event = @reviewEvent");
      values.reviewEvent = params.reviewEvent;
    }
    if (params.publicationMode !== undefined) {
      sets.push("publication_mode = @publicationMode");
      values.publicationMode = params.publicationMode;
    }
    this.db.prepare(`UPDATE review_attempts SET ${sets.join(", ")} WHERE id = @id`).run(values);
    return this.getAttemptById(id);
  }

  listAttempts(limit = 100): ReviewAttemptRecord[] {
    return this.db.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM review_attempts
      ORDER BY id DESC
      LIMIT ?
    `).all(limit).map(mapAttempt);
  }

  listAttemptsForPullRequest(repoFullName: string, prNumber: number, limit = 20): ReviewAttemptRecord[] {
    return this.db.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM review_attempts
      WHERE repo_full_name = ? AND pr_number = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(repoFullName, prNumber, limit).map(mapAttempt);
  }

  listActiveAttemptsForRepo(repoFullName: string, limit = 50): ReviewAttemptRecord[] {
    return this.db.prepare(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM review_attempts
      WHERE repo_full_name = ?
        AND status IN ('queued', 'running')
      ORDER BY id DESC
      LIMIT ?
    `).all(repoFullName, limit).map(mapAttempt);
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
