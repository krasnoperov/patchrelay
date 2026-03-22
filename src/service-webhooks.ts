import type { Logger } from "pino";
import type { AppConfig, LinearWebhookPayload, NormalizedEvent } from "./types.ts";
import { normalizeWebhook } from "./webhooks.ts";
import { timestampMsWithinSkew, verifyHmacSha256Hex } from "./utils.ts";

export interface AcceptedWebhook {
  id: number;
  normalized: NormalizedEvent;
  payload: LinearWebhookPayload;
}

interface WebhookEventStorelike {
  insertWebhookEvent(params: {
    webhookId: string;
    receivedAt: string;
    payloadJson: string;
  }): { id: number; dedupeStatus?: string };
}

export async function acceptIncomingWebhook(params: {
  config: AppConfig;
  stores: {
    webhookEvents: WebhookEventStorelike;
  };
  logger: Logger;
  webhookId: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}): Promise<
  | {
      accepted?: AcceptedWebhook;
      status: number;
      body: Record<string, string | number | boolean>;
    }
  | {
      accepted: AcceptedWebhook;
      status: number;
      body: Record<string, string | number | boolean>;
    }
> {
  const receivedAt = new Date().toISOString();
  const signature = typeof params.headers["linear-signature"] === "string" ? params.headers["linear-signature"] : "";
  if (!verifyHmacSha256Hex(params.rawBody, params.config.linear.webhookSecret, signature)) {
    params.logger.warn({ webhookId: params.webhookId }, "Rejecting webhook with invalid signature");
    return { status: 401, body: { ok: false, reason: "invalid_signature" } };
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(params.rawBody.toString("utf8")) as LinearWebhookPayload;
  } catch {
    params.logger.warn({ webhookId: params.webhookId }, "Rejecting malformed webhook payload");
    return { status: 400, body: { ok: false, reason: "invalid_json" } };
  }

  if (!timestampMsWithinSkew(payload.webhookTimestamp, params.config.ingress.maxTimestampSkewSeconds)) {
    params.logger.warn({ webhookId: params.webhookId, webhookTimestamp: payload.webhookTimestamp }, "Rejecting stale webhook payload");
    return { status: 401, body: { ok: false, reason: "stale_timestamp" } };
  }

  let normalized: NormalizedEvent;
  try {
    normalized = normalizeWebhook({ webhookId: params.webhookId, payload });
  } catch (error) {
    params.logger.warn({ webhookId: params.webhookId, error }, "Rejecting unsupported webhook payload");
    return { status: 400, body: { ok: false, reason: "unsupported_payload" } };
  }

  const payloadJson = JSON.stringify(payload);

  logWebhookSummary(params.logger, normalized);

  const stored = params.stores.webhookEvents.insertWebhookEvent({
    webhookId: params.webhookId,
    receivedAt,
    payloadJson,
  });

  const isDuplicate = stored.dedupeStatus === "duplicate";
  if (isDuplicate) {
    params.logger.info({ webhookId: params.webhookId, webhookEventId: stored.id }, "Ignoring duplicate webhook delivery");
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  params.logger.info(
    {
      webhookId: params.webhookId,
      webhookEventId: stored.id,
      triggerEvent: normalized.triggerEvent,
      issueKey: normalized.issue?.identifier,
      issueId: normalized.issue?.id,
    },
    "Accepted Linear webhook for asynchronous processing",
  );

  return {
    accepted: { id: stored.id, normalized, payload },
    status: 200,
    body: { ok: true, accepted: true, webhookEventId: stored.id },
  };
}

function logWebhookSummary(logger: Logger, normalized: NormalizedEvent): void {
  const issueRef = normalized.issue?.identifier ?? normalized.issue?.id ?? normalized.installation?.appUserId ?? normalized.entityType;
  const stateName = normalized.issue?.stateName;
  const title = normalized.issue?.title;
  const summary = [
    `Linear webhook for ${issueRef}`,
    normalized.triggerEvent,
    stateName ? `to ${stateName}` : undefined,
    title ? `(${title})` : undefined,
  ].filter(Boolean).join(" ");

  logger.info(
    {
      issueKey: normalized.issue?.identifier,
      triggerEvent: normalized.triggerEvent,
      state: stateName,
      title,
      appUserId: normalized.installation?.appUserId,
      notificationType: normalized.installation?.notificationType,
    },
    summary,
  );
  logger.debug(
    { webhookId: normalized.webhookId, eventType: normalized.eventType, issueId: normalized.issue?.id },
    "Webhook metadata",
  );
}
