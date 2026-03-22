import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { normalizeGitHubWebhook, verifyGitHubWebhookSignature } from "./github-webhooks.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppConfig } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

export class GitHubWebhookHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async acceptGitHubWebhook(params: {
    deliveryId: string;
    eventType: string;
    signature: string;
    rawBody: Buffer;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    // Deduplicate
    if (this.db.isWebhookDuplicate(params.deliveryId)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    // Store the event
    const stored = this.db.insertWebhookEvent(params.deliveryId, new Date().toISOString());

    // Parse payload
    const payload = safeJsonParse(params.rawBody.toString("utf8"));
    if (!payload) {
      return { status: 400, body: { ok: false, reason: "invalid_json" } };
    }

    // Find matching project by repo
    const repoFullName = typeof payload === "object" && payload !== null && "repository" in payload
      ? (payload as Record<string, unknown>).repository
      : undefined;
    const repoName = typeof repoFullName === "object" && repoFullName !== null && "full_name" in repoFullName
      ? String((repoFullName as Record<string, string>).full_name)
      : undefined;

    const project = repoName
      ? this.config.projects.find((p) => p.github?.repoFullName === repoName)
      : undefined;

    // Verify signature if project has a webhook secret
    if (project?.github?.webhookSecret) {
      if (!verifyGitHubWebhookSignature(params.rawBody, project.github.webhookSecret, params.signature)) {
        return { status: 401, body: { ok: false, reason: "invalid_signature" } };
      }
    }

    if (stored.duplicate) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    return {
      status: 200,
      body: {
        ok: true,
        accepted: true,
        webhookEventId: stored.id,
        eventType: params.eventType,
        projectId: project?.id,
      },
    };
  }

  async processGitHubWebhookEvent(params: {
    eventType: string;
    rawBody: string;
  }): Promise<void> {
    const payload = safeJsonParse(params.rawBody);
    if (!payload || typeof payload !== "object") return;

    const event = normalizeGitHubWebhook({
      eventType: params.eventType,
      payload: payload as import("./github-types.ts").GitHubWebhookPayload,
    });
    if (!event) {
      this.logger.debug({ eventType: params.eventType }, "GitHub webhook: unrecognized event type or action");
      return;
    }

    // Route to issue via branch name
    const issue = this.db.getIssueByBranch(event.branchName);
    if (!issue) {
      this.logger.debug({ branchName: event.branchName, triggerEvent: event.triggerEvent }, "GitHub webhook: no matching issue for branch");
      return;
    }

    // Update PR state on the issue
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(event.prNumber !== undefined ? { prNumber: event.prNumber } : {}),
      ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
      ...(event.prState !== undefined ? { prState: event.prState } : {}),
      ...(event.reviewState !== undefined ? { prReviewState: event.reviewState } : {}),
      ...(event.checkStatus !== undefined ? { prCheckStatus: event.checkStatus } : {}),
    });

    // Reset repair counters on new push
    if (event.triggerEvent === "pr_synchronize") {
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ciRepairAttempts: 0,
        queueRepairAttempts: 0,
      });
    }

    this.logger.info(
      { issueKey: issue.issueKey, branchName: event.branchName, triggerEvent: event.triggerEvent, prNumber: event.prNumber },
      "GitHub webhook: updated issue PR state",
    );

    this.feed?.publish({
      level: event.triggerEvent.includes("failed") ? "warn" : "info",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.desiredStage ?? undefined,
      status: event.triggerEvent,
      summary: `GitHub: ${event.triggerEvent}${event.prNumber ? ` on PR #${event.prNumber}` : ""}`,
      detail: event.checkName ?? event.reviewBody?.slice(0, 200) ?? undefined,
    });
  }
}
