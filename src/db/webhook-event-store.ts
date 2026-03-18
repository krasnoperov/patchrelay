import type { WebhookEventRecord } from "../types.ts";
import type { DatabaseConnection } from "./shared.ts";

export class WebhookEventStore {
  constructor(private readonly connection: DatabaseConnection) {}

  insertWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    eventType: string;
    issueId?: string;
    projectId?: string;
    headersJson: string;
    payloadJson: string;
    signatureValid: boolean;
    dedupeStatus: WebhookEventRecord["dedupeStatus"];
  }): { id: number; inserted: boolean } {
    const existing = this.connection.prepare("SELECT id FROM webhook_events WHERE webhook_id = ?").get(params.webhookId) as
      | { id: number }
      | undefined;
    if (existing) {
      this.connection.prepare("UPDATE webhook_events SET dedupe_status = 'duplicate' WHERE id = ?").run(existing.id);
      return { id: existing.id, inserted: false };
    }

    const result = this.connection
      .prepare(
        `
        INSERT INTO webhook_events (
          webhook_id, received_at, event_type, issue_id, project_id, headers_json, payload_json, signature_valid, dedupe_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        params.webhookId,
        params.receivedAt,
        params.eventType,
        params.issueId ?? null,
        params.projectId ?? null,
        params.headersJson,
        params.payloadJson,
        params.signatureValid ? 1 : 0,
        params.dedupeStatus,
      );

    return { id: Number(result.lastInsertRowid), inserted: true };
  }

  markWebhookProcessed(id: number, status: WebhookEventRecord["processingStatus"]): void {
    this.connection.prepare("UPDATE webhook_events SET processing_status = ? WHERE id = ?").run(status, id);
  }

  assignWebhookProject(id: number, projectId: string): void {
    this.connection.prepare("UPDATE webhook_events SET project_id = ? WHERE id = ?").run(projectId, id);
  }

  getWebhookEvent(id: number): WebhookEventRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM webhook_events WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? mapWebhookEvent(row) : undefined;
  }

  listWebhookEventsForIssueSince(issueId: string, receivedAfter: string): WebhookEventRecord[] {
    const rows = this.connection
      .prepare(
        `
        SELECT *
        FROM webhook_events
        WHERE issue_id = ?
          AND dedupe_status = 'accepted'
          AND received_at > ?
        ORDER BY received_at ASC, id ASC
        `,
      )
      .all(issueId, receivedAfter) as Record<string, unknown>[];
    return rows.map((row) => mapWebhookEvent(row));
  }
}

function mapWebhookEvent(row: Record<string, unknown>): WebhookEventRecord {
  return {
    id: Number(row.id),
    webhookId: String(row.webhook_id),
    receivedAt: String(row.received_at),
    eventType: String(row.event_type),
    ...(row.issue_id === null ? {} : { issueId: String(row.issue_id) }),
    ...(row.project_id === null ? {} : { projectId: String(row.project_id) }),
    headersJson: String(row.headers_json),
    payloadJson: String(row.payload_json),
    signatureValid: Number(row.signature_valid) === 1,
    dedupeStatus: row.dedupe_status as WebhookEventRecord["dedupeStatus"],
    processingStatus: row.processing_status as WebhookEventRecord["processingStatus"],
  };
}
