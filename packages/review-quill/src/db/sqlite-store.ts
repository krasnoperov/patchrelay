import { SCHEMA_SQL } from "./schema.ts";
import { SqliteConnection, isoNow } from "./shared.ts";
import type {
  ReviewAttemptConclusion,
  ReviewAttemptRecord,
  ReviewAttemptStatus,
  ReviewSurfaceMode,
  WebhookEventRecord,
} from "../types.ts";

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
    ...(row.integration_tree_id ? { integrationTreeId: String(row.integration_tree_id) } : {}),
    ...(row.review_surface_mode ? { reviewSurfaceMode: String(row.review_surface_mode) as ReviewSurfaceMode } : {}),
    ...(row.base_sha ? { baseSha: String(row.base_sha) } : {}),
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
    this.db.exec(SCHEMA_SQL);
    this.addColumnIfMissing("review_attempts", "pr_title", "TEXT");
    this.addColumnIfMissing("review_attempts", "prompt_fingerprint", "TEXT");
    // Carry-forward identity columns. Existing rows backfill NULL and behave
    // as cache misses; new approved rows populate them so future heads can
    // re-emit the verdict without re-running the reviewer.
    this.addColumnIfMissing("review_attempts", "patch_id", "TEXT");
    this.addColumnIfMissing("review_attempts", "integration_tree_id", "TEXT");
    this.addColumnIfMissing("review_attempts", "review_surface_mode", "TEXT");
    this.addColumnIfMissing("review_attempts", "base_sha", "TEXT");
    this.addColumnIfMissing("review_attempts", "prior_attempt_id", "INTEGER");
    this.addColumnIfMissing("review_attempts", "review_body", "TEXT");
    this.addColumnIfMissing("review_attempts", "review_event", "TEXT");
    this.addColumnIfMissing("review_attempts", "publication_mode", "TEXT");
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_review_attempts_patch ON review_attempts(repo_full_name, pr_number, patch_id);`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_review_attempts_patch_tree ON review_attempts(repo_full_name, pr_number, patch_id, integration_tree_id);`);
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
    if (rows.some((row) => String(row.name) === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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

  // Carry-forward lookup for head-mode review surface. Finds an approved
  // attempt with the same patch-id (any prior head) that has a stored
  // body+event we can re-emit on the new head SHA. Filters on
  // review_surface_mode so a project that flips modes doesn't carry
  // across the change. Old rows missing review_body are skipped — that's
  // the rollout-safety contract: only rows written after the migration
  // can serve cache hits.
  findApprovedAttemptByPatchId(
    repoFullName: string,
    prNumber: number,
    patchId: string,
    mode: ReviewSurfaceMode,
    promptFingerprint?: string,
  ): ReviewAttemptRecord | undefined {
    const promptFilter = promptFingerprint ? "AND prompt_fingerprint = ?" : "";
    const row = this.db.prepare(`
      SELECT *
      FROM review_attempts
      WHERE repo_full_name = ?
        AND pr_number = ?
        AND patch_id = ?
        AND status = 'completed'
        AND conclusion = 'approved'
        AND review_body IS NOT NULL
        AND review_event IS NOT NULL
        AND review_surface_mode = ?
        ${promptFilter}
      ORDER BY id DESC
      LIMIT 1
    `).get(...[
      repoFullName,
      prNumber,
      patchId,
      mode,
      ...(promptFingerprint ? [promptFingerprint] : []),
    ]);
    return row ? mapAttempt(row) : undefined;
  }

  // Carry-forward lookup for integration-tree-mode review surface.
  // Stricter than `findApprovedAttemptByPatchId`: both the patch-id AND
  // the integrated tree must match (the synthetic merge tree main moved
  // underneath could differ between the prior and current head). Same
  // rollout-safety filter (review_body / review_event must be present).
  findApprovedAttemptByPatchAndTree(
    repoFullName: string,
    prNumber: number,
    patchId: string,
    integrationTreeId: string,
    mode: ReviewSurfaceMode,
    promptFingerprint?: string,
  ): ReviewAttemptRecord | undefined {
    const promptFilter = promptFingerprint ? "AND prompt_fingerprint = ?" : "";
    const row = this.db.prepare(`
      SELECT *
      FROM review_attempts
      WHERE repo_full_name = ?
        AND pr_number = ?
        AND patch_id = ?
        AND integration_tree_id = ?
        AND status = 'completed'
        AND conclusion = 'approved'
        AND review_body IS NOT NULL
        AND review_event IS NOT NULL
        AND review_surface_mode = ?
        ${promptFilter}
      ORDER BY id DESC
      LIMIT 1
    `).get(...[
      repoFullName,
      prNumber,
      patchId,
      integrationTreeId,
      mode,
      ...(promptFingerprint ? [promptFingerprint] : []),
    ]);
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
    integrationTreeId?: string;
    reviewSurfaceMode?: ReviewSurfaceMode;
    baseSha?: string;
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
        patch_id, integration_tree_id, review_surface_mode, base_sha,
        prior_attempt_id, review_body, review_event, publication_mode,
        conclusion, summary, completed_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
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
      params.integrationTreeId ?? null,
      params.reviewSurfaceMode ?? null,
      params.baseSha ?? null,
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
    integrationTreeId?: string | null;
    reviewSurfaceMode?: ReviewSurfaceMode | null;
    baseSha?: string | null;
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
    if (params.integrationTreeId !== undefined) {
      sets.push("integration_tree_id = @integrationTreeId");
      values.integrationTreeId = params.integrationTreeId;
    }
    if (params.reviewSurfaceMode !== undefined) {
      sets.push("review_surface_mode = @reviewSurfaceMode");
      values.reviewSurfaceMode = params.reviewSurfaceMode;
    }
    if (params.baseSha !== undefined) {
      sets.push("base_sha = @baseSha");
      values.baseSha = params.baseSha;
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

  listActiveAttemptsForRepo(repoFullName: string, limit = 50): ReviewAttemptRecord[] {
    return this.db.prepare(`
      SELECT *
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
