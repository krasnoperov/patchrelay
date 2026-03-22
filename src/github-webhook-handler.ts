import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { resolveFactoryStateFromGitHub } from "./factory-state.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { normalizeGitHubWebhook, verifyGitHubWebhookSignature } from "./github-webhooks.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

export class GitHubWebhookHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
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

    // Drive factory state transitions from GitHub events
    let newState = resolveFactoryStateFromGitHub(event.triggerEvent, issue.factoryState);
    if (newState) {
      // Auto-advance merged → done (delivery is complete)
      if (newState === "merged") {
        newState = "done";
      }
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: newState,
      });
      this.logger.info(
        { issueKey: issue.issueKey, from: issue.factoryState, to: newState, trigger: event.triggerEvent },
        "Factory state transition from GitHub event",
      );

      // Emit Linear activity for significant state changes
      void this.emitLinearActivity(issue, newState, event);
    }

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
      stage: issue.factoryState,
      status: event.triggerEvent,
      summary: `GitHub: ${event.triggerEvent}${event.prNumber ? ` on PR #${event.prNumber}` : ""}`,
      detail: event.checkName ?? event.reviewBody?.slice(0, 200) ?? undefined,
    });

    // Trigger reactive runs if applicable
    this.maybeEnqueueReactiveRun(issue, event);
  }

  private maybeEnqueueReactiveRun(issue: IssueRecord, event: NormalizedGitHubEvent): void {
    // Don't trigger if there's already an active run
    if (issue.activeRunId !== undefined) return;

    if (event.triggerEvent === "check_failed" && issue.prState === "open") {
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: "ci_repair",
        pendingRunContextJson: JSON.stringify({
          checkName: event.checkName,
          checkUrl: event.checkUrl,
        }),
      });
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
      this.logger.info({ issueKey: issue.issueKey, checkName: event.checkName }, "Enqueued CI repair run");
    }

    if (event.triggerEvent === "review_changes_requested") {
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: "review_fix",
        pendingRunContextJson: JSON.stringify({
          reviewBody: event.reviewBody,
          reviewerName: event.reviewerName,
        }),
      });
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
      this.logger.info({ issueKey: issue.issueKey, reviewerName: event.reviewerName }, "Enqueued review fix run");
    }

    if (event.triggerEvent === "merge_group_failed") {
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: "queue_repair",
        pendingRunContextJson: JSON.stringify({
          failureReason: event.mergeGroupFailureReason,
        }),
      });
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
      this.logger.info({ issueKey: issue.issueKey }, "Enqueued merge queue repair run");
    }
  }

  private async emitLinearActivity(
    issue: IssueRecord,
    newState: string,
    event: NormalizedGitHubEvent,
  ): Promise<void> {
    if (!issue.agentSessionId) return;
    const linear = await this.linearProvider.forProject(issue.projectId);
    if (!linear?.createAgentActivity) return;

    const messages: Record<string, string> = {
      pr_open: `PR #${event.prNumber ?? ""} opened.${event.prUrl ? ` ${event.prUrl}` : ""}`,
      awaiting_queue: "PR approved. Awaiting merge queue.",
      changes_requested: `Review requested changes.${event.reviewerName ? ` Reviewer: ${event.reviewerName}` : ""}`,
      repairing_ci: `CI check failed${event.checkName ? `: ${event.checkName}` : ""}. Starting repair.`,
      repairing_queue: "Merge queue failed. Starting repair.",
      done: `PR merged and deployed.${event.prNumber ? ` PR #${event.prNumber}` : ""}`,
      failed: "PR was closed without merging.",
    };

    const body = messages[newState];
    if (!body) return;

    const type = newState === "failed" || newState === "repairing_ci" || newState === "repairing_queue"
      ? "error" as const
      : "response" as const;

    try {
      await linear.createAgentActivity({
        agentSessionId: issue.agentSessionId,
        content: { type, body },
      });
    } catch {
      // Non-blocking — don't fail the webhook for a Linear activity error
    }
  }
}
