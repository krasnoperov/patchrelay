import type { Logger } from "pino";
import { PatchRelayDatabase } from "./db.js";
import { LaunchRunner } from "./launcher.js";
import { resolveProject, triggerEventAllowed } from "./project-resolution.js";
import type { AppConfig, LinearWebhookPayload, NormalizedEvent, WorkflowKind } from "./types.js";
import { safeJsonParse, timestampMsWithinSkew, verifyHmacSha256Hex } from "./utils.js";
import { archiveWebhook } from "./webhook-archive.js";
import { normalizeWebhook } from "./webhooks.js";

class InMemoryQueue {
  private items: number[] = [];
  private pending = false;

  constructor(private readonly onDequeue: (item: number) => Promise<void>, private readonly logger: Logger) {}

  enqueue(item: number): void {
    this.items.push(item);
    if (!this.pending) {
      this.pending = true;
      queueMicrotask(() => {
        void this.drain();
      });
    }
  }

  private async drain(): Promise<void> {
    while (this.items.length > 0) {
      const next = this.items.shift();
      if (next === undefined) {
        continue;
      }

      try {
        await this.onDequeue(next);
      } catch (error) {
        this.logger.error({ error, webhookEventId: next }, "Queue item processing failed");
      }
    }
    this.pending = false;
  }
}

export class PatchRelayService {
  readonly queue: InMemoryQueue;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly launcher: LaunchRunner,
    readonly logger: Logger,
  ) {
    this.queue = new InMemoryQueue((eventId) => this.processWebhookEvent(eventId), logger);
  }

  async acceptWebhook(params: {
    webhookId: string;
    headers: Record<string, string | string[] | undefined>;
    rawBody: Buffer;
  }): Promise<{
    status: number;
    body: Record<string, string | number | boolean>;
  }> {
    const receivedAt = new Date().toISOString();
    let payload: LinearWebhookPayload;
    try {
      payload = JSON.parse(params.rawBody.toString("utf8")) as LinearWebhookPayload;
    } catch {
      this.logger.warn({ webhookId: params.webhookId }, "Rejecting malformed webhook payload");
      return { status: 400, body: { ok: false, reason: "invalid_json" } };
    }

    let normalized: NormalizedEvent;
    try {
      normalized = normalizeWebhook({
        webhookId: params.webhookId,
        payload,
      });
    } catch (error) {
      this.logger.warn({ webhookId: params.webhookId, error }, "Rejecting unsupported webhook payload");
      return { status: 400, body: { ok: false, reason: "unsupported_payload" } };
    }

    this.logger.info(
      {
        webhookId: params.webhookId,
        eventType: normalized.eventType,
        triggerEvent: normalized.triggerEvent,
        issueId: normalized.issue.id,
        issueKey: normalized.issue.identifier,
        issueTitle: normalized.issue.title,
        teamId: normalized.issue.teamId,
        teamKey: normalized.issue.teamKey,
        labelNames: normalized.issue.labelNames,
      },
      "Parsed webhook payload",
    );

    if (this.config.logging.webhookArchiveDir) {
      try {
        const archivePath = await archiveWebhook({
          archiveDir: this.config.logging.webhookArchiveDir,
          webhookId: params.webhookId,
          receivedAt,
          headers: params.headers,
          rawBody: params.rawBody,
          payload,
        });
        this.logger.info(
          {
            webhookId: params.webhookId,
            archivePath,
          },
          "Archived webhook to local file",
        );
      } catch (error) {
        this.logger.error(
          {
            webhookId: params.webhookId,
            error,
          },
          "Failed to archive webhook to local file",
        );
      }
    }

    const signature = typeof params.headers["linear-signature"] === "string" ? params.headers["linear-signature"] : "";
    const validSignature = verifyHmacSha256Hex(params.rawBody, this.config.linear.webhookSecret, signature);
    if (!validSignature) {
      this.db.insertWebhookEvent({
        webhookId: params.webhookId,
        receivedAt,
        eventType: normalized.eventType,
        issueId: normalized.issue.id,
        headersJson: JSON.stringify(params.headers),
        payloadJson: JSON.stringify(payload),
        signatureValid: false,
        dedupeStatus: "rejected",
      });
      return { status: 401, body: { ok: false, reason: "invalid_signature" } };
    }

    this.logger.info({ webhookId: params.webhookId }, "Verified webhook signature");

    if (!timestampMsWithinSkew(payload.webhookTimestamp, this.config.ingress.maxTimestampSkewSeconds)) {
      this.logger.warn({ webhookId: params.webhookId }, "Rejecting webhook outside allowed timestamp skew");
      this.db.insertWebhookEvent({
        webhookId: params.webhookId,
        receivedAt,
        eventType: normalized.eventType,
        issueId: normalized.issue.id,
        headersJson: JSON.stringify(params.headers),
        payloadJson: JSON.stringify(payload),
        signatureValid: true,
        dedupeStatus: "rejected",
      });
      return { status: 401, body: { ok: false, reason: "stale_timestamp" } };
    }

    this.logger.info({ webhookId: params.webhookId }, "Verified webhook timestamp freshness");

    const stored = this.db.insertWebhookEvent({
      webhookId: params.webhookId,
      receivedAt,
      eventType: normalized.eventType,
      issueId: normalized.issue.id,
      headersJson: JSON.stringify(params.headers),
      payloadJson: JSON.stringify(payload),
      signatureValid: true,
      dedupeStatus: "accepted",
    });

    if (!stored.inserted) {
      this.logger.info({ webhookId: params.webhookId, issueId: normalized.issue.id }, "Ignoring duplicate webhook");
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    this.logger.info(
      {
        webhookId: params.webhookId,
        issueId: normalized.issue.id,
        eventType: normalized.eventType,
        triggerEvent: normalized.triggerEvent,
      },
      "Accepted webhook",
    );
    this.queue.enqueue(stored.id);
    return { status: 200, body: { ok: true, accepted: true, webhookEventId: stored.id } };
  }

  async processWebhookEvent(webhookEventId: number): Promise<void> {
    const event = this.db.getWebhookEvent(webhookEventId);
    if (!event) {
      this.logger.warn({ webhookEventId }, "Webhook event missing from database");
      return;
    }

    const payload = safeJsonParse<LinearWebhookPayload>(event.payloadJson);
    if (!payload) {
      this.db.markWebhookProcessed(webhookEventId, "failed");
      throw new Error(`Stored webhook payload is invalid JSON: event ${webhookEventId}`);
    }

    const normalized = normalizeWebhook({
      webhookId: event.webhookId,
      payload,
    });

    const project = resolveProject(this.config, normalized.issue);
    if (!project) {
      this.logger.info(
        {
          webhookId: event.webhookId,
          issueId: normalized.issue.id,
          issueKey: normalized.issue.identifier,
        },
        "Ignoring webhook because no project matches the issue metadata",
      );
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    this.logger.info(
      {
        webhookId: event.webhookId,
        projectId: project.id,
        issueId: normalized.issue.id,
        issueKey: normalized.issue.identifier,
        triggerEvent: normalized.triggerEvent,
      },
      "Resolved project from webhook metadata",
    );

    this.db.assignWebhookProject(webhookEventId, project.id);
    const existingIssue = this.db.getIssue(project.id, normalized.issue.id);
    this.db.upsertIssue({
      projectId: project.id,
      linearIssueId: normalized.issue.id,
      currentState: existingIssue?.currentState ?? "received",
      lastWebhookAt: new Date().toISOString(),
      ...(normalized.issue.identifier ? { linearIssueKey: normalized.issue.identifier } : {}),
      ...(normalized.issue.title ? { title: normalized.issue.title } : {}),
      ...(existingIssue?.branchName ? { branchName: existingIssue.branchName } : {}),
      ...(existingIssue?.worktreePath ? { worktreePath: existingIssue.worktreePath } : {}),
      ...(existingIssue ? { activeRunId: existingIssue.activeRunId ?? null } : {}),
    });

    if (!triggerEventAllowed(project, normalized.triggerEvent)) {
      this.logger.info(
        {
          webhookId: event.webhookId,
          projectId: project.id,
          issueId: normalized.issue.id,
          triggerEvent: normalized.triggerEvent,
          allowedTriggerEvents: project.triggerEvents,
        },
        "Ignoring webhook because trigger event is not enabled for the project",
      );
      this.db.updateIssueState(project.id, normalized.issue.id, "ignored");
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    const workflowKind = this.resolveWorkflowKind(project, normalized);
    if (!workflowKind) {
      this.logger.info(
        {
          webhookId: event.webhookId,
          projectId: project.id,
          issueId: normalized.issue.id,
          triggerEvent: normalized.triggerEvent,
          stateName: normalized.issue.stateName,
        },
        "Ignoring webhook because no automation workflow matches the issue status",
      );
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    const currentIssue = this.db.getIssue(project.id, normalized.issue.id);
    if (currentIssue?.currentState === "launching" || currentIssue?.currentState === "running") {
      this.logger.info(
        {
          projectId: project.id,
          issueId: normalized.issue.id,
          currentState: currentIssue.currentState,
        },
        "Ignoring webhook because an active run already exists for the issue",
      );
      this.db.markWebhookProcessed(webhookEventId, "processed");
      return;
    }

    try {
      const plan = await this.launcher.launch({
        project,
        issue: normalized.issue,
        webhookId: normalized.webhookId,
        workflowKind,
      });
      this.logger.info(
        {
          projectId: project.id,
          issueId: normalized.issue.id,
          issueKey: normalized.issue.identifier,
          workflowKind: plan.workflowKind,
          workflowFile: plan.workflowFile,
          branchName: plan.branchName,
          worktreePath: plan.worktreePath,
          sessionName: plan.sessionName,
        },
        "Launch completed",
      );
      this.db.markWebhookProcessed(webhookEventId, "processed");
    } catch (error) {
      this.db.markWebhookProcessed(webhookEventId, "failed");
      this.logger.error(
        {
          projectId: project.id,
          issueId: normalized.issue.id,
          issueKey: normalized.issue.identifier,
          error,
        },
        "Launch failed",
      );
    }
  }

  private resolveWorkflowKind(project: AppConfig["projects"][number], normalized: NormalizedEvent): WorkflowKind | undefined {
    if (normalized.triggerEvent !== "statusChanged") {
      return undefined;
    }

    const stateName = normalized.issue.stateName?.trim().toLowerCase();
    if (!stateName) {
      return undefined;
    }

    if (stateName === project.workflowStatuses.implementation.trim().toLowerCase()) {
      return "implementation";
    }
    if (stateName === project.workflowStatuses.review.trim().toLowerCase()) {
      return "review";
    }
    if (stateName === project.workflowStatuses.deploy.trim().toLowerCase()) {
      return "deploy";
    }
    return undefined;
  }
}
