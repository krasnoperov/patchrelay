import type { Logger } from "pino";
import { PatchRelayDatabase } from "./db.js";
import type { AppConfig, LinearWebhookPayload, NormalizedEvent } from "./types.js";
import { archiveWebhook } from "./webhook-archive.js";
import { normalizeWebhook } from "./webhooks.js";
import { redactSensitiveHeaders, timestampMsWithinSkew, verifyHmacSha256Hex } from "./utils.js";

export interface AcceptedWebhook {
  id: number;
  normalized: NormalizedEvent;
  payload: LinearWebhookPayload;
}

export async function acceptIncomingWebhook(params: {
  config: AppConfig;
  db: PatchRelayDatabase;
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
  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(params.rawBody.toString("utf8")) as LinearWebhookPayload;
  } catch {
    params.logger.warn({ webhookId: params.webhookId }, "Rejecting malformed webhook payload");
    return { status: 400, body: { ok: false, reason: "invalid_json" } };
  }

  let normalized: NormalizedEvent;
  try {
    normalized = normalizeWebhook({
      webhookId: params.webhookId,
      payload,
    });
  } catch (error) {
    params.logger.warn({ webhookId: params.webhookId, error }, "Rejecting unsupported webhook payload");
    return { status: 400, body: { ok: false, reason: "unsupported_payload" } };
  }

  logWebhookSummary(params.logger, normalized);
  await archiveAcceptedPayload({
    config: params.config,
    logger: params.logger,
    webhookId: params.webhookId,
    receivedAt,
    headers: params.headers,
    rawBody: params.rawBody,
    payload,
  });

  const signature = typeof params.headers["linear-signature"] === "string" ? params.headers["linear-signature"] : "";
  const sanitizedHeaders = redactSensitiveHeaders(params.headers);
  const headersJson = JSON.stringify(sanitizedHeaders);
  const payloadJson = JSON.stringify(payload);

  if (!verifyHmacSha256Hex(params.rawBody, params.config.linear.webhookSecret, signature)) {
    persistRejectedWebhook(params.db, {
      webhookId: params.webhookId,
      receivedAt,
      normalized,
      headersJson,
      payloadJson,
      signatureValid: false,
    });
    return { status: 401, body: { ok: false, reason: "invalid_signature" } };
  }

  if (!timestampMsWithinSkew(payload.webhookTimestamp, params.config.ingress.maxTimestampSkewSeconds)) {
    persistRejectedWebhook(params.db, {
      webhookId: params.webhookId,
      receivedAt,
      normalized,
      headersJson,
      payloadJson,
      signatureValid: true,
    });
    return { status: 401, body: { ok: false, reason: "stale_timestamp" } };
  }

  const stored = params.db.insertWebhookEvent({
    webhookId: params.webhookId,
    receivedAt,
    eventType: normalized.eventType,
    issueId: normalized.issue.id,
    headersJson,
    payloadJson,
    signatureValid: true,
    dedupeStatus: "accepted",
  });
  if (!stored.inserted) {
    return { status: 200, body: { ok: true, duplicate: true } };
  }

  return {
    accepted: {
      id: stored.id,
      normalized,
      payload,
    },
    status: 200,
    body: { ok: true, accepted: true, webhookEventId: stored.id },
  };
}

function logWebhookSummary(logger: Logger, normalized: NormalizedEvent): void {
  const issueRef = normalized.issue.identifier ?? normalized.issue.id;
  const stateName = normalized.issue.stateName;
  const title = normalized.issue.title;
  const summary = [
    `Linear webhook for ${issueRef}`,
    normalized.triggerEvent,
    stateName ? `to ${stateName}` : undefined,
    title ? `(${title})` : undefined,
  ]
    .filter(Boolean)
    .join(" ");

  logger.info(
    {
      issueKey: normalized.issue.identifier,
      triggerEvent: normalized.triggerEvent,
      state: stateName,
      title,
    },
    summary,
  );
  logger.debug(
    {
      webhookId: normalized.webhookId,
      eventType: normalized.eventType,
      issueId: normalized.issue.id,
    },
    "Webhook metadata",
  );
}

async function archiveAcceptedPayload(params: {
  config: AppConfig;
  logger: Logger;
  webhookId: string;
  receivedAt: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  payload: LinearWebhookPayload;
}): Promise<void> {
  if (!params.config.logging.webhookArchiveDir) {
    return;
  }

  try {
    const archivePath = await archiveWebhook({
      archiveDir: params.config.logging.webhookArchiveDir,
      webhookId: params.webhookId,
      receivedAt: params.receivedAt,
      headers: redactSensitiveHeaders(params.headers),
      rawBody: params.rawBody,
      payload: params.payload,
    });
    params.logger.debug({ webhookId: params.webhookId, archivePath }, "Archived webhook to local file");
  } catch (error) {
    params.logger.error({ webhookId: params.webhookId, error }, "Failed to archive webhook to local file");
  }
}

function persistRejectedWebhook(
  db: PatchRelayDatabase,
  params: {
    webhookId: string;
    receivedAt: string;
    normalized: NormalizedEvent;
    headersJson: string;
    payloadJson: string;
    signatureValid: boolean;
  },
): void {
  db.insertWebhookEvent({
    webhookId: params.webhookId,
    receivedAt: params.receivedAt,
    eventType: params.normalized.eventType,
    issueId: params.normalized.issue.id,
    headersJson: params.headersJson,
    payloadJson: params.payloadJson,
    signatureValid: params.signatureValid,
    dedupeStatus: "rejected",
  });
}
