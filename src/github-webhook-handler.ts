import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import { resolveFactoryStateFromGitHub } from "./factory-state.ts";
import type { GitHubWebhookPayload, NormalizedGitHubEvent } from "./github-types.ts";
import { normalizeGitHubWebhook, verifyGitHubWebhookSignature } from "./github-webhooks.ts";
import { buildAgentSessionPlanForIssue } from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import { buildGitHubStateActivity } from "./linear-session-reporting.ts";
import type { MergeQueue } from "./merge-queue.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveSecret } from "./resolve-secret.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { safeJsonParse } from "./utils.ts";

/**
 * GitHub sends both check_run and check_suite completion events.
 * A single CI run generates 10+ individual check_run events as each job finishes,
 * but only 1 check_suite event when the entire suite completes. Reacting to
 * individual check_run events causes the factory state to flicker rapidly
 * between pr_open and repairing_ci. We only drive state transitions and reactive
 * runs from check_suite events. Individual check_run events still update PR
 * metadata (prCheckStatus) for observability.
 */
function isMetadataOnlyCheckEvent(event: NormalizedGitHubEvent): boolean {
  return event.eventSource === "check_run"
    && (event.triggerEvent === "check_passed" || event.triggerEvent === "check_failed");
}

export class GitHubWebhookHandler {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly mergeQueue: MergeQueue,
    private readonly logger: Logger,
    private readonly codex: { steerTurn(options: { threadId: string; turnId: string; input: string }): Promise<void> },
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

    // Verify signature using global GitHub App webhook secret
    const webhookSecret = resolveSecret("github-app-webhook-secret", "GITHUB_APP_WEBHOOK_SECRET");
    if (webhookSecret) {
      if (!verifyGitHubWebhookSignature(params.rawBody, webhookSecret, params.signature)) {
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

    // Push to a base branch advances the merge queue for affected projects.
    // This catches external merges (human PRs, direct pushes) that PatchRelay
    // does not track as issues but that make queued branches stale.
    if (params.eventType === "push") {
      const pushPayload = payload as { ref?: string; repository?: { full_name?: string } };
      const ref = pushPayload.ref;
      const repoFullName = pushPayload.repository?.full_name;
      if (ref && repoFullName) {
        const branchName = ref.replace("refs/heads/", "");
        for (const project of this.config.projects) {
          const baseBranch = project.github?.baseBranch ?? "main";
          if (project.github?.repoFullName === repoFullName && branchName === baseBranch) {
            this.mergeQueue.advanceQueue(project.id);
          }
        }
      }
      return;
    }

    if (params.eventType === "issue_comment") {
      await this.handlePrComment(payload as Record<string, unknown>);
      return;
    }

    const event = normalizeGitHubWebhook({
      eventType: params.eventType,
      payload: payload as GitHubWebhookPayload,
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

    if (!isMetadataOnlyCheckEvent(event)) {
      // Re-read issue after PR metadata upsert so guards see fresh prReviewState
      const afterMetadata = this.db.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

      const newState = resolveFactoryStateFromGitHub(event.triggerEvent, afterMetadata.factoryState, {
        prReviewState: afterMetadata.prReviewState,
        activeRunId: afterMetadata.activeRunId,
      });

      // Only transition and notify when the state actually changes.
      // Multiple check_suite events can arrive for the same outcome.
      if (newState && newState !== afterMetadata.factoryState) {
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          factoryState: newState,
        });
        this.logger.info(
          { issueKey: issue.issueKey, from: afterMetadata.factoryState, to: newState, trigger: event.triggerEvent },
          "Factory state transition from GitHub event",
        );

        const transitionedIssue = this.db.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
        void this.emitLinearActivity(transitionedIssue, newState, event);
        void this.syncLinearSession(transitionedIssue);

        // Schedule merge prep when entering awaiting_queue
        if (newState === "awaiting_queue") {
          this.db.upsertIssue({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            pendingMergePrep: true,
          });
          this.enqueueIssue(issue.projectId, issue.linearIssueId);
        }

        // Advance the merge queue when a PR merges
        if (newState === "done" && event.triggerEvent === "pr_merged") {
          this.mergeQueue.advanceQueue(issue.projectId);
        }
      }

      // Advance the merge queue even when the state transition was suppressed
      // (e.g., pr_merged during an active run). The PR is factually merged —
      // the next queued issue should not wait for the active run to finish.
      if (!newState && event.triggerEvent === "pr_merged") {
        this.mergeQueue.advanceQueue(issue.projectId);
      }
    }

    // Re-read issue after all upserts so reactive run logic sees current state
    const freshIssue = this.db.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

    // Reset repair counters on new push — but only when no repair run is active,
    // since Codex pushes during repair and resetting mid-run would bypass budgets.
    if (event.triggerEvent === "pr_synchronize" && !freshIssue.activeRunId) {
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
      issueKey: freshIssue.issueKey,
      projectId: freshIssue.projectId,
      stage: freshIssue.factoryState,
      status: event.triggerEvent,
      summary: `GitHub: ${event.triggerEvent}${event.prNumber ? ` on PR #${event.prNumber}` : ""}`,
      detail: event.checkName ?? event.reviewBody?.slice(0, 200) ?? undefined,
    });

    if (!isMetadataOnlyCheckEvent(event)) {
      const project = this.config.projects.find((p) => p.id === freshIssue.projectId);
      this.maybeEnqueueReactiveRun(freshIssue, event, project);
    }
  }

  private maybeEnqueueReactiveRun(issue: IssueRecord, event: NormalizedGitHubEvent, project?: ProjectConfig): void {
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
          checkClass: resolveCheckClass(event.checkName, project),
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
    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear?.createAgentActivity) return;
      const content = buildGitHubStateActivity(issue.factoryState, event);
      if (!content) return;
      const allowEphemeral = content.type === "thought" || content.type === "action";
      await linear.createAgentActivity({
        agentSessionId: issue.agentSessionId,
        content,
        ...(allowEphemeral ? { ephemeral: false } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, newState, error: msg }, "Failed to emit Linear activity from GitHub webhook");
      this.feed?.publish({
        level: "warn",
        kind: "linear",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        status: "linear_error",
        summary: `Linear activity failed: ${msg}`,
      });
    }
  }

  private async syncLinearSession(issue: IssueRecord): Promise<void> {
    if (!issue.agentSessionId) return;
    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear?.updateAgentSession) return;
      const externalUrls = buildAgentSessionExternalUrls(this.config, {
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
      });
      await linear.updateAgentSession({
        agentSessionId: issue.agentSessionId,
        plan: buildAgentSessionPlanForIssue(issue),
        ...(externalUrls ? { externalUrls } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync Linear session from GitHub webhook");
    }
  }

  private async handlePrComment(payload: Record<string, unknown>): Promise<void> {
    if (payload.action !== "created") return;
    const issuePayload = payload.issue as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (!issuePayload || !comment) return;
    if (!issuePayload.pull_request) return; // only PR comments
    const body = typeof comment.body === "string" ? comment.body : "";
    if (!body.trim()) return;
    const user = comment.user as Record<string, unknown> | undefined;
    const author = typeof user?.login === "string" ? user.login : "unknown";
    if (typeof user?.type === "string" && user.type === "Bot") return;
    const prNumber = typeof issuePayload.number === "number" ? issuePayload.number : undefined;
    if (!prNumber) return;
    const issue = this.db.getIssueByPrNumber(prNumber);
    if (!issue) return;

    this.feed?.publish({
      level: "info",
      kind: "comment",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: issue.factoryState,
      status: "pr_comment",
      summary: `GitHub PR comment from ${author}`,
      detail: body.slice(0, 200),
    });

    if (issue.activeRunId) {
      const run = this.db.getRun(issue.activeRunId);
      if (run?.threadId && run.turnId) {
        try {
          await this.codex.steerTurn({
            threadId: run.threadId,
            turnId: run.turnId,
            input: `GitHub PR comment from ${author}:\n\n${body}`,
          });
          this.logger.info({ issueKey: issue.issueKey, author }, "Forwarded GitHub PR comment to active run");
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to forward GitHub PR comment");
        }
      }
    }
  }
}

function resolveCheckClass(
  checkName: string | undefined,
  project: ProjectConfig | undefined,
): "code" | "review" | "gate" {
  if (!checkName || !project) return "code";
  if (project.reviewChecks.some((name) => checkName.includes(name))) return "review";
  if (project.gateChecks.some((name) => checkName.includes(name))) return "gate";
  return "code";
}
