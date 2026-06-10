import type { DatabaseConnection } from "./shared.ts";

/**
 * Rows older than this that are still `pending` were abandoned by a crash or
 * restart mid-processing. They are never replayed — recovery is re-derivation
 * from GitHub/Linear via reconciliation — so the startup sweep marks them
 * `abandoned`, which makes them archiveable like any other terminal status.
 */
export const ABANDONED_PENDING_WEBHOOK_AGE_MS = 15 * 60 * 1000;

export interface WebhookEventArchiveRecord {
  id: number;
  webhookId: string;
  receivedAt: string;
  projectId?: string | undefined;
  payloadJson?: string | undefined;
  processingStatus: string;
}

export class WebhookEventStore {
  constructor(private readonly connection: DatabaseConnection) {}

  insertWebhookEvent(webhookId: string, receivedAt: string): { id: number; duplicate: boolean } {
    const existing = this.connection
      .prepare("SELECT id FROM webhook_events WHERE webhook_id = ?")
      .get(webhookId) as { id: number } | undefined;
    if (existing) {
      return { id: existing.id as number, duplicate: true };
    }
    const result = this.connection
      .prepare("INSERT INTO webhook_events (webhook_id, received_at, processing_status) VALUES (?, ?, 'processed')")
      .run(webhookId, receivedAt);
    return { id: Number(result.lastInsertRowid), duplicate: false };
  }

  insertFullWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    payloadJson: string;
  }): { id: number; dedupeStatus: string } {
    const existing = this.connection
      .prepare("SELECT id FROM webhook_events WHERE webhook_id = ?")
      .get(params.webhookId) as { id: number } | undefined;
    if (existing) {
      return { id: existing.id as number, dedupeStatus: "duplicate" };
    }
    const result = this.connection
      .prepare("INSERT INTO webhook_events (webhook_id, received_at, payload_json) VALUES (?, ?, ?)")
      .run(params.webhookId, params.receivedAt, params.payloadJson);
    return { id: Number(result.lastInsertRowid), dedupeStatus: "accepted" };
  }

  getWebhookPayload(id: number): { webhookId: string; payloadJson: string } | undefined {
    const row = this.connection.prepare("SELECT webhook_id, payload_json FROM webhook_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row || !row.payload_json) return undefined;
    return { webhookId: String(row.webhook_id), payloadJson: String(row.payload_json) };
  }

  isWebhookDuplicate(webhookId: string): boolean {
    return this.connection.prepare("SELECT 1 FROM webhook_events WHERE webhook_id = ?").get(webhookId) !== undefined;
  }

  markWebhookProcessed(id: number, status: string): void {
    this.connection.prepare("UPDATE webhook_events SET processing_status = ? WHERE id = ?").run(status, id);
  }

  /**
   * Startup maintenance (core simplification plan, phase C2): mark rows stuck
   * at `pending` since before the cutoff as `abandoned` so the retention pass
   * can archive them. Returns the number of rows marked — each one is a
   * crash-interrupted processing attempt worth surfacing to the operator.
   */
  markAbandonedPendingEventsBefore(cutoffIso: string): number {
    const result = this.connection.prepare(`
      UPDATE webhook_events
      SET processing_status = 'abandoned'
      WHERE processing_status = 'pending'
        AND received_at < ?
    `).run(cutoffIso);
    return Number(result.changes ?? 0);
  }

  assignWebhookProject(id: number, projectId: string): void {
    this.connection.prepare("UPDATE webhook_events SET project_id = ? WHERE id = ?").run(projectId, id);
  }

  listArchiveableEventsBefore(cutoffIso: string, limit: number): WebhookEventArchiveRecord[] {
    const rows = this.connection.prepare(`
      SELECT id, webhook_id, received_at, project_id, payload_json, processing_status
      FROM webhook_events
      WHERE received_at < ?
        AND processing_status != 'pending'
      ORDER BY received_at ASC, id ASC
      LIMIT ?
    `).all(cutoffIso, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: Number(row.id),
      webhookId: String(row.webhook_id),
      receivedAt: String(row.received_at),
      ...(row.project_id != null ? { projectId: String(row.project_id) } : {}),
      ...(row.payload_json != null ? { payloadJson: String(row.payload_json) } : {}),
      processingStatus: String(row.processing_status),
    }));
  }

  countArchiveableEventsBefore(cutoffIso: string): number {
    const row = this.connection.prepare(`
      SELECT COUNT(*) AS count
      FROM webhook_events
      WHERE received_at < ?
        AND processing_status != 'pending'
    `).get(cutoffIso) as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  }

  deleteWebhookEventsByIds(ids: number[]): number {
    if (ids.length === 0) return 0;
    return this.connection.transaction(() => {
      let deleted = 0;
      const statement = this.connection.prepare("DELETE FROM webhook_events WHERE id = ?");
      for (const id of ids) {
        const result = statement.run(id);
        deleted += Number(result.changes ?? 0);
      }
      return deleted;
    })();
  }

  findLatestAgentSessionIdForIssue(linearIssueId: string): string | undefined {
    const row = this.connection.prepare(`
      SELECT COALESCE(
        json_extract(payload_json, '$.agentSession.id'),
        json_extract(payload_json, '$.data.agentSession.id'),
        json_extract(payload_json, '$.agentSessionId'),
        json_extract(payload_json, '$.data.agentSessionId')
      ) AS agent_session_id
      FROM webhook_events
      WHERE COALESCE(
        json_extract(payload_json, '$.agentSession.issueId'),
        json_extract(payload_json, '$.data.agentSession.issueId'),
        json_extract(payload_json, '$.agentSession.issue.id'),
        json_extract(payload_json, '$.data.agentSession.issue.id')
      ) = ?
        AND COALESCE(
          json_extract(payload_json, '$.agentSession.id'),
          json_extract(payload_json, '$.data.agentSession.id'),
          json_extract(payload_json, '$.agentSessionId'),
          json_extract(payload_json, '$.data.agentSessionId')
        ) IS NOT NULL
      ORDER BY id DESC
      LIMIT 1
    `).get(linearIssueId) as Record<string, unknown> | undefined;

    return row?.agent_session_id != null ? String(row.agent_session_id) : undefined;
  }
}
