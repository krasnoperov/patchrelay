import type { Logger } from "pino";
import { PatchRelayDatabase } from "./db.js";
import { buildLaunchPlan, LaunchRunner } from "./launcher.js";
import { resolveProject, triggerEventAllowed } from "./project-resolution.js";
import type { AppConfig, LinearWebhookPayload, NormalizedEvent, PersistedIssueRecord, ProjectConfig, WorkflowKind } from "./types.js";
import { safeJsonParse, timestampMsWithinSkew, verifyHmacSha256Hex } from "./utils.js";
import { archiveWebhook } from "./webhook-archive.js";
import { normalizeWebhook } from "./webhooks.js";

const RECONCILE_INTERVAL_MS = 30 * 1000;
const ISSUE_KEY_DELIMITER = "::";

class InMemoryQueue<T> {
  private items: T[] = [];
  private pending = false;

  constructor(private readonly onDequeue: (item: T) => Promise<void>, private readonly logger: Logger) {}

  enqueue(item: T): void {
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
        this.logger.error({ error, item: next }, "Queue item processing failed");
      }
    }
    this.pending = false;
  }
}

function makeIssueQueueKey(projectId: string, issueId: string): string {
  return `${projectId}${ISSUE_KEY_DELIMITER}${issueId}`;
}

function parseIssueQueueKey(value: string): { projectId: string; issueId: string } {
  const [projectId, issueId] = value.split(ISSUE_KEY_DELIMITER);
  if (!projectId || !issueId) {
    throw new Error(`Invalid issue queue key: ${value}`);
  }
  return { projectId, issueId };
}

export class PatchRelayService {
  readonly webhookQueue: InMemoryQueue<number>;
  readonly issueQueue: InMemoryQueue<string>;
  private reconcileTimer: NodeJS.Timeout | undefined;

  constructor(
    readonly config: AppConfig,
    readonly db: PatchRelayDatabase,
    readonly launcher: LaunchRunner,
    readonly logger: Logger,
  ) {
    this.webhookQueue = new InMemoryQueue((eventId) => this.processWebhookEvent(eventId), logger);
    this.issueQueue = new InMemoryQueue((issueKey) => this.processIssue(issueKey), logger);
    this.launcher.setRunCompletionHandler(async ({ projectId, linearIssueId }) => {
      this.issueQueue.enqueue(makeIssueQueueKey(projectId, linearIssueId));
    });
  }

  async start(): Promise<void> {
    await this.reconcileActiveRuns();
    for (const issue of this.db.listIssuesReadyForLaunch()) {
      this.issueQueue.enqueue(makeIssueQueueKey(issue.projectId, issue.linearIssueId));
    }
    this.reconcileTimer = setInterval(() => {
      void this.reconcileActiveRuns();
    }, RECONCILE_INTERVAL_MS);
  }

  stop(): void {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
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
        this.logger.info({ webhookId: params.webhookId, archivePath }, "Archived webhook to local file");
      } catch (error) {
        this.logger.error({ webhookId: params.webhookId, error }, "Failed to archive webhook to local file");
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
    this.webhookQueue.enqueue(stored.id);
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

    this.db.assignWebhookProject(webhookEventId, project.id);
    const existingIssue = this.db.getIssue(project.id, normalized.issue.id);
    const issue = this.db.upsertIssue({
      projectId: project.id,
      linearIssueId: normalized.issue.id,
      currentState: existingIssue?.currentState ?? "received",
      lastWebhookAt: new Date().toISOString(),
      ...(normalized.issue.identifier ? { linearIssueKey: normalized.issue.identifier } : {}),
      ...(normalized.issue.title ? { title: normalized.issue.title } : {}),
      ...(normalized.issue.url ? { issueUrl: normalized.issue.url } : {}),
      ...(existingIssue?.branchName ? { branchName: existingIssue.branchName } : {}),
      ...(existingIssue?.worktreePath ? { worktreePath: existingIssue.worktreePath } : {}),
      ...(existingIssue ? { activeRunId: existingIssue.activeRunId ?? null } : {}),
      ...(existingIssue ? { activeStage: existingIssue.activeStage ?? null } : {}),
      ...(existingIssue ? { desiredStage: existingIssue.desiredStage ?? null } : {}),
      ...(existingIssue ? { desiredStateName: existingIssue.desiredStateName ?? null } : {}),
      ...(existingIssue ? { desiredWebhookId: existingIssue.desiredWebhookId ?? null } : {}),
      ...(existingIssue ? { desiredWebhookTimestamp: existingIssue.desiredWebhookTimestamp ?? null } : {}),
      ...(existingIssue ? { leaseOwner: existingIssue.leaseOwner ?? null } : {}),
      ...(existingIssue ? { leaseExpiresAt: existingIssue.leaseExpiresAt ?? null } : {}),
      ...(existingIssue ? { lastHeartbeatAt: existingIssue.lastHeartbeatAt ?? null } : {}),
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
    const recordedIssue = this.db.recordDesiredStage({
      projectId: project.id,
      linearIssueId: normalized.issue.id,
      currentState: workflowKind ? issue.currentState : "ignored",
      ...(normalized.issue.identifier ? { linearIssueKey: normalized.issue.identifier } : {}),
      ...(normalized.issue.title ? { title: normalized.issue.title } : {}),
      ...(normalized.issue.url ? { issueUrl: normalized.issue.url } : {}),
      ...(workflowKind ? { desiredStage: workflowKind } : {}),
      ...(normalized.issue.stateName ? { desiredStateName: normalized.issue.stateName } : {}),
      desiredWebhookId: normalized.webhookId,
      desiredWebhookTimestamp: normalized.payload.webhookTimestamp,
      lastWebhookAt: new Date().toISOString(),
    });

    if (!workflowKind) {
      this.logger.info(
        {
          webhookId: event.webhookId,
          projectId: project.id,
          issueId: normalized.issue.id,
          stateName: normalized.issue.stateName,
        },
        "Recorded non-trigger state update without launching work",
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
        workflowKind,
        currentState: recordedIssue.currentState,
        activeRunId: recordedIssue.activeRunId,
      },
      "Recorded desired stage from webhook",
    );
    this.db.markWebhookProcessed(webhookEventId, "processed");
    this.issueQueue.enqueue(makeIssueQueueKey(project.id, normalized.issue.id));
  }

  private async processIssue(issueQueueKey: string): Promise<void> {
    const { projectId, issueId } = parseIssueQueueKey(issueQueueKey);
    const project = this.config.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      this.logger.warn({ projectId, issueId }, "Cannot process issue because project is missing from config");
      return;
    }

    const issue = this.db.getIssue(projectId, issueId);
    if (!issue) {
      return;
    }

    if (issue.activeRunId) {
      this.logger.debug?.({ projectId, issueId, activeRunId: issue.activeRunId }, "Issue already has an active run");
      return;
    }

    if (!issue.desiredStage || !issue.desiredWebhookId) {
      return;
    }

    const plan = buildLaunchPlan(
      this.config,
      project,
      {
        id: issue.linearIssueId,
        ...(issue.linearIssueKey ? { identifier: issue.linearIssueKey } : {}),
        ...(issue.title ? { title: issue.title } : {}),
        ...(issue.issueUrl ? { url: issue.issueUrl } : {}),
        labelNames: [],
      },
      issue.desiredStage,
    );

    try {
      const launched = await this.launcher.launch({
        project,
        issue,
        workflowKind: issue.desiredStage,
        triggerWebhookId: issue.desiredWebhookId,
      });
      if (!launched) {
        return;
      }

      this.logger.info(
        {
          projectId,
          issueId,
          issueKey: issue.linearIssueKey,
          workflowKind: launched.workflowKind,
          workflowFile: launched.workflowFile,
          branchName: launched.branchName,
          worktreePath: launched.worktreePath,
          sessionName: launched.sessionName,
        },
        "Launch completed",
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          projectId,
          issueId,
          issueKey: issue.linearIssueKey,
          err: error,
          errorMessage,
          stage: plan.stage,
        },
        "Launch failed",
      );
      this.issueQueue.enqueue(issueQueueKey);
    }
  }

  private async reconcileActiveRuns(): Promise<void> {
    const activeIssues = this.db.listIssuesWithActiveRuns();
    if (activeIssues.length === 0) {
      return;
    }

    for (const issue of activeIssues) {
      const project = this.config.projects.find((candidate) => candidate.id === issue.projectId);
      if (!project) {
        continue;
      }

      if (!issue.activeRunId) {
        this.db.clearActiveRun({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          nextState: issue.currentState === "launching" ? "failed" : issue.currentState,
        });
        if (issue.desiredStage) {
          this.issueQueue.enqueue(makeIssueQueueKey(issue.projectId, issue.linearIssueId));
        }
        continue;
      }

      const run = this.db.getIssueRun(issue.activeRunId);
      const session = this.db.getSessionByRun(issue.activeRunId);
      if (!run) {
        this.db.clearActiveRun({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          runId: issue.activeRunId,
          nextState: "failed",
        });
        this.issueQueue.enqueue(makeIssueQueueKey(issue.projectId, issue.linearIssueId));
        continue;
      }

      if (!session) {
        const leaseExpired = issue.leaseExpiresAt ? Date.parse(issue.leaseExpiresAt) <= Date.now() : true;
        if (leaseExpired) {
          this.db.finishIssueRun({
            runId: run.id,
            status: "failed",
            errorJson: JSON.stringify({ message: "Run lease expired before a session was recorded" }),
          });
          this.db.clearActiveRun({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            runId: run.id,
            nextState: "failed",
          });
          this.issueQueue.enqueue(makeIssueQueueKey(issue.projectId, issue.linearIssueId));
        }
        continue;
      }

      const sessionState = await this.launcher.getSessionState(session.zmxSessionName).catch((error) => {
        this.logger.error(
          {
            error,
            projectId: issue.projectId,
            issueId: issue.linearIssueId,
            sessionName: session.zmxSessionName,
          },
          "Failed to inspect session state during reconciliation",
        );
        return { kind: "missing" } as const;
      });

      if (sessionState.kind === "running") {
        this.launcher.resumeSessionMonitoring({
          project,
          issue,
          run,
          session,
        });
        continue;
      }

      const exitCode = sessionState.kind === "completed" ? sessionState.exitCode : 1;
      this.db.finishSession(session.id, exitCode);
      this.db.finishIssueRun({
        runId: run.id,
        status: exitCode === 0 ? "completed" : "failed",
        ...(exitCode === 0 ? { resultJson: JSON.stringify({ exitCode, recovered: true }) } : { errorJson: JSON.stringify({ exitCode, recovered: true }) }),
      });
      this.db.clearActiveRun({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        runId: run.id,
        nextState: exitCode === 0 ? "completed" : "failed",
      });
      this.issueQueue.enqueue(makeIssueQueueKey(issue.projectId, issue.linearIssueId));
    }
  }

  private resolveWorkflowKind(project: ProjectConfig, normalized: NormalizedEvent): WorkflowKind | undefined {
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
