import type { DatabaseConnection } from "./shared.ts";

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

  assignWebhookProject(id: number, projectId: string): void {
    this.connection.prepare("UPDATE webhook_events SET project_id = ? WHERE id = ?").run(projectId, id);
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
