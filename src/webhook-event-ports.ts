import type { WebhookEventRecord } from "./types.ts";

// Webhook receipts are authoritative coordination state because PatchRelay must
// deduplicate deliveries and resume processing correctly after a restart.
export interface WebhookEventStore {
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
  }): { id: number; inserted: boolean };
  markWebhookProcessed(id: number, status: WebhookEventRecord["processingStatus"]): void;
  assignWebhookProject(id: number, projectId: string): void;
  getWebhookEvent(id: number): WebhookEventRecord | undefined;
  listWebhookEventsForIssueSince(issueId: string, receivedAfter: string): WebhookEventRecord[];
}

export interface WebhookEventStoreProvider {
  webhookEvents: WebhookEventStore;
}
