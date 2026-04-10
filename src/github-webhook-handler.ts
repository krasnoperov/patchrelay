import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { GitHubCiSnapshotRecord, IssueRecord } from "./db-types.ts";
import { resolveFactoryStateFromGitHub, type FactoryState } from "./factory-state.ts";
import {
  createGitHubCiSnapshotResolver,
  createGitHubFailureContextResolver,
  summarizeGitHubFailureContext,
  type GitHubCiSnapshotResolver,
  type GitHubFailureContextResolver,
} from "./github-failure-context.ts";
import type { GitHubWebhookPayload, NormalizedGitHubEvent } from "./github-types.ts";
import { normalizeGitHubWebhook, verifyGitHubWebhookSignature } from "./github-webhooks.ts";
import { buildAgentSessionPlanForIssue } from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import { buildGitHubStateActivity } from "./linear-session-reporting.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import {
  resolveMergeQueueProtocol,
} from "./merge-queue-protocol.ts";
import { buildQueueRepairContextFromEvent } from "./merge-queue-incident.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import {
  buildClosedPrCleanupFields,
  isIssueTerminal,
  resolveClosedPrFactoryState,
  resolveClosedPrDisposition,
} from "./pr-state.ts";
import { resolveSecret } from "./resolve-secret.ts";
import type { AppConfig, LinearClientProvider } from "./types.ts";
import type { ProjectConfig } from "./workflow-types.ts";
import { safeJsonParse } from "./utils.ts";

/**
 * GitHub sends both check_run and check_suite completion events.
 * A single CI run generates many individual check_run events as each job finishes,
 * but PatchRelay should only start ci_repair once the configured gate check
 * (for example `Tests`) has gone terminal for the current PR head SHA. We still
 * treat most check_run events as metadata-only and only react to queue eviction
 * checks or the settled gate check.
 */
function isMetadataOnlyCheckEvent(event: NormalizedGitHubEvent): boolean {
  return event.eventSource === "check_run"
    && (event.triggerEvent === "check_passed" || event.triggerEvent === "check_failed");
}

const DEFAULT_GATE_CHECK_NAMES = ["verify", "tests"];

interface GitHubFailurePromptContext {
  source?: "branch_ci" | "queue_eviction" | undefined;
  repoFullName?: string | undefined;
  capturedAt?: string | undefined;
  headSha?: string | undefined;
  failureHeadSha?: string | undefined;
  failureSignature?: string | undefined;
  checkName?: string | undefined;
  checkUrl?: string | undefined;
  checkDetailsUrl?: string | undefined;
  workflowRunId?: number | undefined;
  workflowName?: string | undefined;
  jobName?: string | undefined;
  stepName?: string | undefined;
  summary?: string | undefined;
  annotations?: string[] | undefined;
}

interface GitHubReviewThreadComment {
  id: number;
  body: string;
  path?: string | undefined;
  line?: number | undefined;
  side?: string | undefined;
  startLine?: number | undefined;
  startSide?: string | undefined;
  commitId?: string | undefined;
  url?: string | undefined;
  diffHunk?: string | undefined;
  authorLogin?: string | undefined;
}

type FetchLike = typeof fetch;

export class GitHubWebhookHandler {
  private readonly patchRelayAuthorLogins = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly codex: { steerTurn(options: { threadId: string; turnId: string; input: string }): Promise<void> },
    private readonly feed?: OperatorEventFeed,
    private readonly failureContextResolver: GitHubFailureContextResolver = createGitHubFailureContextResolver(),
    private readonly ciSnapshotResolver: GitHubCiSnapshotResolver = createGitHubCiSnapshotResolver(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    for (const login of resolvePatchRelayAuthorLoginsFromEnv()) {
      this.patchRelayAuthorLogins.add(login);
    }
  }

  setPatchRelayAuthorLogins(logins: string[]): void {
    this.patchRelayAuthorLogins.clear();
    for (const login of logins) {
      const normalized = normalizeAuthorLogin(login);
      if (normalized) {
        this.patchRelayAuthorLogins.add(normalized);
      }
    }
  }

  async acceptGitHubWebhook(params: {
    deliveryId: string;
    eventType: string;
    signature: string;
    rawBody: Buffer;
  }): Promise<{ status: number; body: Record<string, unknown> }> {
    // Deduplicate
    if (this.db.webhookEvents.isWebhookDuplicate(params.deliveryId)) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    // Store the event
    const stored = this.db.webhookEvents.insertWebhookEvent(params.deliveryId, new Date().toISOString());

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
        // Push to base branch — external merge queue handles advancement.
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
    const issue = this.db.issues.getIssueByBranch(event.branchName);
    if (!issue) {
      this.logger.debug({ branchName: event.branchName, triggerEvent: event.triggerEvent }, "GitHub webhook: no matching issue for branch");
      return;
    }

    const project = this.config.projects.find((p) => p.id === issue.projectId);

    const immediateCheckStatus = this.deriveImmediatePrCheckStatus(issue, event, project);

    // Update PR state on the issue
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(event.prNumber !== undefined ? { prNumber: event.prNumber } : {}),
      ...(event.prUrl !== undefined ? { prUrl: event.prUrl } : {}),
      ...(event.prState !== undefined ? { prState: event.prState } : {}),
      ...(event.headSha !== undefined ? { prHeadSha: event.headSha } : {}),
      ...(event.prAuthorLogin !== undefined ? { prAuthorLogin: event.prAuthorLogin } : {}),
      ...(event.reviewState !== undefined ? { prReviewState: event.reviewState } : {}),
      ...(immediateCheckStatus !== undefined ? { prCheckStatus: immediateCheckStatus } : {}),
      ...(event.reviewState === "changes_requested"
        ? { lastBlockingReviewHeadSha: event.reviewCommitId ?? event.headSha ?? null }
        : event.reviewState === "approved"
          ? { lastBlockingReviewHeadSha: null }
          : {}),
      ...(event.triggerEvent === "pr_closed"
        ? buildClosedPrCleanupFields()
        : {}),
    });
    await this.updateCiSnapshot(issue, event, project);
    await this.updateFailureProvenance(issue, event, project);

    const queueEvictionCheck = this.isQueueEvictionFailure(issue, event, project);

    if (!isMetadataOnlyCheckEvent(event) || queueEvictionCheck) {
      // Re-read issue after PR metadata upsert so guards see fresh prReviewState
      const afterMetadata = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

      const newState = this.resolveFactoryStateForEvent(afterMetadata, event, project);

      // Only transition and notify when the state actually changes.
      // Multiple check_suite events can arrive for the same outcome.
      if (newState && newState !== afterMetadata.factoryState) {
        this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          factoryState: newState,
        });
        this.logger.info(
          { issueKey: issue.issueKey, from: afterMetadata.factoryState, to: newState, trigger: event.triggerEvent },
          "Factory state transition from GitHub event",
        );

        const transitionedIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
        void this.emitLinearActivity(transitionedIssue, newState, event);
        void this.syncLinearSession(transitionedIssue);

      }
    }

    // Re-read issue after all upserts so reactive run logic sees current state
    const freshIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;

    // Reset repair counters on new push — but only when no repair run is active,
    // since Codex pushes during repair and resetting mid-run would bypass budgets.
    if (event.triggerEvent === "pr_synchronize" && !freshIssue.activeRunId) {
      this.db.issueSessions.upsertIssueRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ciRepairAttempts: 0,
        queueRepairAttempts: 0,
        lastGitHubFailureSource: null,
        lastGitHubFailureHeadSha: null,
        lastGitHubFailureSignature: null,
        lastGitHubFailureCheckName: null,
        lastGitHubFailureCheckUrl: null,
        lastGitHubFailureContextJson: null,
        lastGitHubFailureAt: null,
        lastGitHubCiSnapshotHeadSha: event.headSha ?? null,
        lastGitHubCiSnapshotGateCheckName: this.getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
        lastQueueIncidentJson: null,
        lastAttemptedFailureHeadSha: null,
        lastAttemptedFailureSignature: null,
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

    // Queue eviction check runs bypass the metadata-only filter because
    // they're individual check_run events (not check_suite), but they
    // must drive state transitions.
    if (queueEvictionCheck || this.isGateCheckEvent(event, project)) {
      await this.maybeEnqueueReactiveRun(freshIssue, event, project);
    } else if (!isMetadataOnlyCheckEvent(event)) {
      await this.maybeEnqueueReactiveRun(freshIssue, event, project);
    }

    if (event.triggerEvent === "pr_merged" || event.triggerEvent === "pr_closed") {
      await this.handleTerminalPrEvent(freshIssue, event);
    }
  }

  private resolveFactoryStateForEvent(
    issue: IssueRecord,
    event: NormalizedGitHubEvent,
    project?: ProjectConfig,
  ): FactoryState | undefined {
    if (event.triggerEvent === "pr_closed") {
      return undefined;
    }

    if (
      event.triggerEvent === "check_failed"
      && this.isQueueEvictionFailure(issue, event, project)
      && issue.prState === "open"
      && issue.activeRunId === undefined
      && !isIssueTerminal(issue)
    ) {
      return "repairing_queue";
    }

    return resolveFactoryStateFromGitHub(event.triggerEvent, issue.factoryState, {
      prReviewState: issue.prReviewState,
      activeRunId: issue.activeRunId,
    });
  }

  private async updateCiSnapshot(
    issue: IssueRecord,
    event: NormalizedGitHubEvent,
    project?: ProjectConfig,
  ): Promise<void> {
    if (event.triggerEvent === "pr_merged") {
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubCiSnapshotHeadSha: null,
        lastGitHubCiSnapshotGateCheckName: null,
        lastGitHubCiSnapshotGateCheckStatus: null,
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      });
      return;
    }

    if (event.triggerEvent === "pr_synchronize") {
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubCiSnapshotHeadSha: event.headSha ?? null,
        lastGitHubCiSnapshotGateCheckName: this.getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      });
      return;
    }

    if (issue.prState !== "open") return;
    if (event.eventSource !== "check_run") return;
    if (this.isQueueEvictionFailure(issue, event, project)) return;
    if (!this.isGateCheckEvent(event, project)) return;
    if (this.isStaleGateEvent(issue, event)) return;

    const snapshot = await this.ciSnapshotResolver.resolve({
      repoFullName: project?.github?.repoFullName ?? event.repoFullName,
      event,
      gateCheckNames: this.getGateCheckNames(project),
    });
    if (!snapshot) {
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubCiSnapshotHeadSha: event.headSha ?? issue.lastGitHubCiSnapshotHeadSha ?? null,
        lastGitHubCiSnapshotGateCheckName: this.getPrimaryGateCheckName(project),
        lastGitHubCiSnapshotGateCheckStatus: "pending",
        lastGitHubCiSnapshotJson: null,
        lastGitHubCiSnapshotSettledAt: null,
      });
      this.logger.warn(
        { issueKey: issue.issueKey, repoFullName: project?.github?.repoFullName ?? event.repoFullName, headSha: event.headSha },
        "Could not resolve settled CI snapshot; waiting before CI repair",
      );
      this.feed?.publish({
        level: "warn",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: issue.factoryState,
        status: "ci_snapshot_unavailable",
        summary: `Could not resolve settled ${this.getPrimaryGateCheckName(project)} snapshot; waiting before CI repair`,
      });
      return;
    }

    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      prCheckStatus: snapshot.gateCheckStatus,
      lastGitHubCiSnapshotHeadSha: snapshot.headSha,
      lastGitHubCiSnapshotGateCheckName: snapshot.gateCheckName ?? this.getPrimaryGateCheckName(project),
      lastGitHubCiSnapshotGateCheckStatus: snapshot.gateCheckStatus,
      lastGitHubCiSnapshotJson: JSON.stringify(snapshot),
      lastGitHubCiSnapshotSettledAt: snapshot.settledAt ?? null,
    });
  }

  private async maybeEnqueueReactiveRun(issue: IssueRecord, event: NormalizedGitHubEvent, project?: ProjectConfig): Promise<void> {
    // Don't trigger if there's already an active run
    if (issue.activeRunId !== undefined) return;

    // Don't trigger on terminal issues — late-arriving webhooks (e.g.
    // merge_group_failed after pr_merged) must not resurrect done issues.
    if (isIssueTerminal(issue)) return;

    if (!this.isPatchRelayOwnedPr(issue)) {
      this.feed?.publish({
        level: "info",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: issue.factoryState,
        status: "ignored_non_patchrelay_pr",
        summary: `Ignored ${event.triggerEvent} on non-PatchRelay-owned PR`,
      });
      return;
    }

    if (event.triggerEvent === "check_failed" && issue.prState === "open") {
      // External merge queue eviction: react only to the configured check
      // name, not to any CI failure. Regular CI failures still get ci_repair.
      if (this.isQueueEvictionFailure(issue, event, project)) {
        const queueRepairContext = buildQueueRepairContextFromEvent(event);
        const failureContext = this.buildQueueFailureContext(issue, event, queueRepairContext);
        if (this.hasDuplicatePendingReactiveRun(issue, "queue_repair", failureContext)) {
          return;
        }
        const hadPendingWake = this.db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId);
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          lastGitHubFailureSource: "queue_eviction",
          lastGitHubFailureHeadSha: failureContext.failureHeadSha ?? null,
          lastGitHubFailureSignature: failureContext.failureSignature ?? null,
          lastGitHubFailureCheckName: event.checkName ?? null,
          lastGitHubFailureCheckUrl: event.checkUrl ?? null,
          lastGitHubFailureContextJson: JSON.stringify(failureContext),
          lastGitHubFailureAt: new Date().toISOString(),
          lastQueueSignalAt: new Date().toISOString(),
          lastQueueIncidentJson: JSON.stringify(queueRepairContext),
        });
        this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          eventType: "merge_steward_incident",
          eventJson: JSON.stringify({
            ...queueRepairContext,
            ...failureContext,
          }),
          dedupeKey: failureContext.failureSignature,
        });
        this.db.issueSessions.setBranchOwnerRespectingActiveLease(issue.projectId, issue.linearIssueId, "patchrelay");
        const queuedRunType = hadPendingWake
          ? this.peekPendingSessionWakeRunType(issue.projectId, issue.linearIssueId)
          : this.enqueuePendingSessionWake(issue.projectId, issue.linearIssueId);
        this.logger.info({ issueKey: issue.issueKey, checkName: event.checkName }, "Queue eviction detected, enqueued queue repair");
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "repairing_queue",
          status: "queue_repair_queued",
          summary: `${queuedRunType ?? "queue_repair"} queued after external failure from ${event.checkName}`,
          detail: queueRepairContext.incidentSummary ?? queueRepairContext.incidentUrl ?? event.checkUrl,
        });
      } else {
        if (!this.isSettledBranchFailure(issue, event, project)) {
          this.feed?.publish({
            level: "info",
            kind: "github",
            issueKey: issue.issueKey,
            projectId: issue.projectId,
            stage: issue.factoryState,
            status: "ci_waiting_for_settlement",
            summary: `Waiting for settled ${this.getPrimaryGateCheckName(project)} result before starting CI repair`,
          });
          return;
        }
        const failureContext = await this.resolveBranchFailureContext(issue, event, project);
        if (this.hasDuplicatePendingReactiveRun(issue, "ci_repair", failureContext)) {
          return;
        }
        const hadPendingWake = this.db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId);
        const snapshot = this.getRelevantCiSnapshot(issue, event);
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          lastGitHubFailureSource: "branch_ci",
          lastGitHubFailureHeadSha: failureContext.failureHeadSha ?? null,
          lastGitHubFailureSignature: failureContext.failureSignature ?? null,
          lastGitHubFailureCheckName: failureContext.checkName ?? event.checkName ?? null,
          lastGitHubFailureCheckUrl: failureContext.checkUrl ?? event.checkUrl ?? null,
          lastGitHubFailureContextJson: JSON.stringify(failureContext),
          lastGitHubFailureAt: new Date().toISOString(),
          lastQueueIncidentJson: null,
        });
        this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          eventType: "settled_red_ci",
          eventJson: JSON.stringify({
            ...failureContext,
            checkClass: resolveCheckClass(failureContext.checkName ?? event.checkName, project),
            ...(snapshot ? { ciSnapshot: snapshot } : {}),
          }),
          dedupeKey: failureContext.failureSignature,
        });
        this.db.issueSessions.setBranchOwnerRespectingActiveLease(issue.projectId, issue.linearIssueId, "patchrelay");
        const queuedRunType = hadPendingWake
          ? this.peekPendingSessionWakeRunType(issue.projectId, issue.linearIssueId)
          : this.enqueuePendingSessionWake(issue.projectId, issue.linearIssueId);
        this.logger.info({ issueKey: issue.issueKey, checkName: failureContext.checkName ?? event.checkName }, "Enqueued CI repair run");
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "repairing_ci",
          status: "ci_repair_queued",
          summary: `${queuedRunType ?? "ci_repair"} queued for ${failureContext.jobName ?? failureContext.checkName ?? "failed check"}`,
          detail: summarizeGitHubFailureContext(failureContext),
        });
      }
    }

    if (event.triggerEvent === "review_changes_requested") {
      const hadPendingWake = this.db.issueSessions.hasPendingIssueSessionEvents(issue.projectId, issue.linearIssueId);
      const reviewComments = await this.fetchReviewCommentsForEvent(event).catch((error) => {
        this.logger.warn(
          {
            issueKey: issue.issueKey,
            prNumber: event.prNumber,
            reviewId: event.reviewId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to fetch inline review comments for requested-changes event",
        );
        return undefined;
      });
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "review_changes_requested",
        eventJson: JSON.stringify({
          reviewBody: event.reviewBody,
          reviewCommitId: event.reviewCommitId,
          reviewId: event.reviewId,
          reviewUrl: buildGitHubReviewUrl(event.repoFullName, event.prNumber, event.reviewId),
          reviewerName: event.reviewerName,
          ...(reviewComments && reviewComments.length > 0 ? { reviewComments } : {}),
        }),
        dedupeKey: [
          "review_changes_requested",
          issue.prHeadSha ?? event.headSha ?? "unknown-sha",
          event.reviewerName ?? "unknown-reviewer",
        ].join("::"),
      });
      this.db.issueSessions.setBranchOwnerRespectingActiveLease(issue.projectId, issue.linearIssueId, "patchrelay");
      const queuedRunType = hadPendingWake
        ? this.peekPendingSessionWakeRunType(issue.projectId, issue.linearIssueId)
        : this.enqueuePendingSessionWake(issue.projectId, issue.linearIssueId);
      this.logger.info({ issueKey: issue.issueKey, reviewerName: event.reviewerName }, "Enqueued review fix run");
      this.feed?.publish({
        level: "warn",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "changes_requested",
        status: "review_fix_queued",
        summary: `${queuedRunType ?? "review_fix"} queued after requested changes`,
        detail: reviewComments && reviewComments.length > 0
          ? `${reviewComments.length} inline review comment${reviewComments.length === 1 ? "" : "s"} captured`
          : event.reviewBody?.slice(0, 200) ?? event.reviewerName,
      });
    }

  }

  private async handleTerminalPrEvent(issue: IssueRecord, event: NormalizedGitHubEvent): Promise<void> {
    const eventType = event.triggerEvent === "pr_merged" ? "pr_merged" : "pr_closed";
    this.db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType,
      dedupeKey: [eventType, issue.prNumber ?? event.prNumber ?? "unknown-pr", issue.prHeadSha ?? event.headSha ?? "unknown-sha"].join("::"),
    });
    this.db.issueSessions.clearPendingIssueSessionEventsRespectingActiveLease(issue.projectId, issue.linearIssueId);

    const run = issue.activeRunId ? this.db.runs.getRunById(issue.activeRunId) : undefined;
    if (run?.threadId && run.turnId) {
      try {
        await this.codex.steerTurn({
          threadId: run.threadId,
          turnId: run.turnId,
          input: event.triggerEvent === "pr_merged"
            ? "STOP: The pull request has already merged. Stop working immediately and exit without making further changes."
            : "STOP: The pull request was closed. Stop working immediately and exit without making further changes.",
        });
      } catch (error) {
        this.logger.warn({ issueKey: issue.issueKey, runId: run.id, error: error instanceof Error ? error.message : String(error) }, "Failed to steer active run after terminal PR event");
      }
    }

    const commitTerminalUpdate = () => {
      if (run) {
        this.db.runs.finishRun(run.id, {
          status: "released",
          failureReason: event.triggerEvent === "pr_merged"
            ? "Pull request merged during active run"
            : "Pull request closed during active run",
        });
      }
      const terminalFactoryState = event.triggerEvent === "pr_merged"
        ? "done"
        : resolveClosedPrFactoryState(issue);
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        activeRunId: null,
        factoryState: terminalFactoryState,
      });
    };
    const activeLease = this.db.issueSessions.getActiveIssueSessionLease(issue.projectId, issue.linearIssueId);
    if (activeLease) {
      this.db.issueSessions.withIssueSessionLease(issue.projectId, issue.linearIssueId, activeLease.leaseId, commitTerminalUpdate);
    } else {
      this.db.transaction(commitTerminalUpdate);
    }
    this.db.issueSessions.releaseIssueSessionLeaseRespectingActiveLease(issue.projectId, issue.linearIssueId);
    const updatedIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    if (event.triggerEvent === "pr_closed" && resolveClosedPrDisposition(issue) === "redelegate") {
      this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        eventType: "delegated",
        dedupeKey: `github_pr_closed:implementation:${issue.linearIssueId}`,
      });
      this.db.issueSessions.setBranchOwnerRespectingActiveLease(issue.projectId, issue.linearIssueId, "patchrelay");
      if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
    }
    if (event.triggerEvent === "pr_merged") {
      await this.completeLinearIssueAfterMerge(updatedIssue);
    }
    void this.syncLinearSession(updatedIssue);
  }

  private async completeLinearIssueAfterMerge(issue: IssueRecord): Promise<void> {
    const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
    if (!linear) return;

    try {
      const liveIssue = await linear.getIssue(issue.linearIssueId);
      const targetState = resolvePreferredCompletedLinearState(liveIssue);
      if (!targetState) {
        this.logger.warn({ issueKey: issue.issueKey }, "Could not find a completed Linear workflow state after merge");
        return;
      }

      const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
      if (normalizedCurrent === targetState.trim().toLowerCase()) {
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
          ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
        });
        return;
      }

      const updated = await linear.setIssueState(issue.linearIssueId, targetState);
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
        ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to move merged issue to a completed Linear state");
    }
  }

  private async updateFailureProvenance(issue: IssueRecord, event: NormalizedGitHubEvent, project?: ProjectConfig): Promise<void> {
    const isQueueEvictionCheck = this.isQueueEvictionFailure(issue, event, project);

    if (event.triggerEvent === "check_failed" && issue.prState === "open") {
      const source = isQueueEvictionCheck
        ? "queue_eviction"
        : "branch_ci";
      if (source === "branch_ci" && !this.isSettledBranchFailure(issue, event, project)) {
        return;
      }
      const failureContext = source === "queue_eviction"
        ? this.buildQueueFailureContext(issue, event)
        : await this.resolveBranchFailureContext(issue, event, project);
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubFailureSource: source,
        lastGitHubFailureHeadSha: failureContext.failureHeadSha ?? event.headSha ?? null,
        lastGitHubFailureSignature: failureContext.failureSignature ?? null,
        lastGitHubFailureCheckName: failureContext.checkName ?? event.checkName ?? null,
        lastGitHubFailureCheckUrl: failureContext.checkUrl ?? event.checkUrl ?? null,
        lastGitHubFailureContextJson: JSON.stringify(failureContext),
        lastGitHubFailureAt: new Date().toISOString(),
        ...(source === "queue_eviction"
          ? {
              lastQueueSignalAt: new Date().toISOString(),
              lastQueueIncidentJson: JSON.stringify(buildQueueRepairContextFromEvent(event)),
            }
          : {
              lastQueueIncidentJson: null,
            }),
      });
      return;
    }

    if (
      (event.triggerEvent === "check_passed" && (!isMetadataOnlyCheckEvent(event) || isQueueEvictionCheck || this.isGateCheckEvent(event, project)))
      || event.triggerEvent === "pr_synchronize"
      || event.triggerEvent === "pr_merged"
    ) {
      if (event.triggerEvent === "check_passed" && !this.canClearFailureProvenance(issue, event, project)) {
        return;
      }
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubFailureSource: null,
        lastGitHubFailureHeadSha: null,
        lastGitHubFailureSignature: null,
        lastGitHubFailureCheckName: null,
        lastGitHubFailureCheckUrl: null,
        lastGitHubFailureContextJson: null,
        lastGitHubFailureAt: null,
        lastQueueIncidentJson: null,
        lastAttemptedFailureHeadSha: null,
        lastAttemptedFailureSignature: null,
      });
    }
  }

  private async resolveBranchFailureContext(
    issue: IssueRecord,
    event: NormalizedGitHubEvent,
    project?: ProjectConfig,
  ): Promise<GitHubFailurePromptContext> {
    const repoFullName = project?.github?.repoFullName ?? event.repoFullName;
    const snapshot = this.getRelevantCiSnapshot(issue, event);
    const primaryFailedCheck = snapshot ? this.pickPrimaryFailedCheck(snapshot) : undefined;
    const context = await this.failureContextResolver.resolve({
      source: "branch_ci",
      repoFullName,
      event: primaryFailedCheck
        ? {
            ...event,
            checkName: primaryFailedCheck.name,
            checkUrl: primaryFailedCheck.detailsUrl ?? event.checkUrl,
            checkDetailsUrl: primaryFailedCheck.detailsUrl ?? event.checkDetailsUrl,
          }
        : event,
    });
    return {
      ...(context ? context : {}),
      ...(context?.headSha || event.headSha ? { failureHeadSha: context?.headSha ?? event.headSha } : {}),
      ...(context?.failureSignature ? { failureSignature: context.failureSignature } : {}),
    };
  }

  private buildQueueFailureContext(
    issue: IssueRecord,
    event: NormalizedGitHubEvent,
    queueRepairContext?: unknown,
  ): GitHubFailurePromptContext {
    const repoFullName = event.repoFullName || this.config.projects.find((p) => p.id === issue.projectId)?.github?.repoFullName || "";
    const incident = queueRepairContext && typeof queueRepairContext === "object"
      ? queueRepairContext as { incidentSummary?: string; incidentUrl?: string }
      : undefined;
    const summary = typeof incident?.incidentSummary === "string"
      ? incident.incidentSummary
      : event.checkOutputSummary ?? event.checkOutputTitle;
    const failureHeadSha = event.headSha;
    const failureSignature = [
      "queue_eviction",
      failureHeadSha ?? "unknown-sha",
      event.checkName ?? "merge-steward/queue",
    ].join("::");
    return {
      source: "queue_eviction",
      repoFullName,
      capturedAt: new Date().toISOString(),
      ...(failureHeadSha ? { headSha: failureHeadSha, failureHeadSha } : {}),
      ...(event.checkName ? { checkName: event.checkName } : {}),
      ...(event.checkUrl ? { checkUrl: event.checkUrl } : {}),
      ...(event.checkDetailsUrl ? { checkDetailsUrl: event.checkDetailsUrl } : {}),
      ...(summary ? { summary } : {}),
      failureSignature,
    };
  }

  private hasDuplicatePendingReactiveRun(
    issue: IssueRecord,
    runType: "ci_repair" | "queue_repair",
    failureContext: GitHubFailurePromptContext,
  ): boolean {
    const signature = typeof failureContext.failureSignature === "string" ? failureContext.failureSignature : undefined;
    const headSha = typeof failureContext.failureHeadSha === "string"
      ? failureContext.failureHeadSha
      : typeof failureContext.headSha === "string" ? failureContext.headSha : undefined;
    if (!signature) return false;

    const pendingWake = this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    if (pendingWake?.runType === runType) {
      const existing = pendingWake.context;
      if (existing?.failureSignature === signature
        && (headSha === undefined || existing.failureHeadSha === headSha || existing.headSha === headSha)) {
        this.feed?.publish({
          level: "info",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: issue.factoryState,
          status: "repair_deduped",
          summary: `Skipped duplicate ${runType} for ${signature}`,
        });
        return true;
      }
    }

    if (issue.lastAttemptedFailureSignature === signature
      && (headSha === undefined || issue.lastAttemptedFailureHeadSha === headSha)) {
      this.feed?.publish({
        level: "info",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: issue.factoryState,
        status: "repair_deduped",
        summary: `Already attempted ${runType} for this failing PR head`,
      });
      return true;
    }

    return false;
  }

  private getGateCheckNames(project?: ProjectConfig): string[] {
    const configured = (project?.gateChecks ?? []).map((entry) => entry.trim()).filter(Boolean);
    return configured.length > 0 ? configured : DEFAULT_GATE_CHECK_NAMES;
  }

  private getPrimaryGateCheckName(project?: ProjectConfig): string {
    return this.getGateCheckNames(project)[0] ?? "verify";
  }

  private isGateCheckEvent(event: NormalizedGitHubEvent, project?: ProjectConfig): boolean {
    if (event.eventSource !== "check_run" || !event.checkName) return false;
    const normalized = event.checkName.trim().toLowerCase();
    return this.getGateCheckNames(project).some((entry) => entry.trim().toLowerCase() === normalized);
  }

  private deriveImmediatePrCheckStatus(
    issue: IssueRecord,
    event: NormalizedGitHubEvent,
    project?: ProjectConfig,
  ): "pending" | "success" | "failure" | undefined {
    if (event.triggerEvent === "pr_synchronize") {
      return "pending";
    }
    if (event.eventSource !== "check_run") {
      return undefined;
    }
    if (!this.isGateCheckEvent(event, project)) {
      return undefined;
    }
    if (this.isStaleGateEvent(issue, event)) {
      return undefined;
    }
    return event.checkStatus;
  }

  private isStaleGateEvent(issue: IssueRecord, event: NormalizedGitHubEvent): boolean {
    return Boolean(
      issue.lastGitHubCiSnapshotHeadSha
      && event.headSha
      && issue.lastGitHubCiSnapshotHeadSha !== event.headSha,
    );
  }

  private isQueueEvictionFailure(issue: IssueRecord, event: NormalizedGitHubEvent, project?: ProjectConfig): boolean {
    const protocol = resolveMergeQueueProtocol(project);
    return event.eventSource === "check_run"
      && event.checkName === protocol.evictionCheckName;
  }

  private isSettledBranchFailure(issue: IssueRecord, event: NormalizedGitHubEvent, project?: ProjectConfig): boolean {
    if (event.triggerEvent !== "check_failed" || issue.prState !== "open") return false;
    if (!this.isGateCheckEvent(event, project)) return false;
    const snapshot = this.getRelevantCiSnapshot(issue, event);
    return snapshot?.gateCheckStatus === "failure" && snapshot.headSha === event.headSha;
  }

  private canClearFailureProvenance(issue: IssueRecord, event: NormalizedGitHubEvent, project?: ProjectConfig): boolean {
    if (event.triggerEvent !== "check_passed") return true;
    if (this.isQueueEvictionFailure(issue, event, project)) {
      return !issue.lastGitHubFailureHeadSha || issue.lastGitHubFailureHeadSha === event.headSha;
    }
    if (!this.isGateCheckEvent(event, project)) {
      return true;
    }
    if (this.isStaleGateEvent(issue, event)) {
      return false;
    }
    return !issue.lastGitHubFailureHeadSha || issue.lastGitHubFailureHeadSha === event.headSha;
  }

  private getRelevantCiSnapshot(issue: IssueRecord, event: NormalizedGitHubEvent): GitHubCiSnapshotRecord | undefined {
    const snapshot = this.db.issues.getLatestGitHubCiSnapshot(issue.projectId, issue.linearIssueId);
    if (!snapshot) return undefined;
    if (snapshot.headSha !== event.headSha) return undefined;
    return snapshot;
  }

  private pickPrimaryFailedCheck(snapshot: GitHubCiSnapshotRecord): { name: string; detailsUrl?: string | undefined } | undefined {
    const gateName = snapshot.gateCheckName?.trim().toLowerCase();
    return snapshot.failedChecks.find((entry) => entry.name.trim().toLowerCase() !== gateName)
      ?? snapshot.failedChecks[0];
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

  private async fetchReviewCommentsForEvent(
    event: NormalizedGitHubEvent,
  ): Promise<GitHubReviewThreadComment[] | undefined> {
    if (event.triggerEvent !== "review_changes_requested") {
      return undefined;
    }
    if (!event.repoFullName || event.prNumber === undefined || event.reviewId === undefined) {
      return undefined;
    }

    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (!token) {
      this.logger.debug(
        { prNumber: event.prNumber, reviewId: event.reviewId },
        "Skipping inline review comment fetch because no GitHub API token is available",
      );
      return undefined;
    }

    const [owner, repo] = event.repoFullName.split("/", 2);
    if (!owner || !repo) {
      return undefined;
    }

    const response = await this.fetchImpl(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${event.prNumber}/reviews/${event.reviewId}/comments?per_page=100`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "patchrelay",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub review comment fetch failed (${response.status})`);
    }

    const payload = await response.json() as unknown;
    if (!Array.isArray(payload)) {
      return undefined;
    }

    const comments: GitHubReviewThreadComment[] = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const body = typeof record.body === "string" ? record.body.trim() : "";
      const id = typeof record.id === "number" ? record.id : undefined;
      if (!body || id === undefined) continue;
      comments.push({
        id,
        body,
        ...(typeof record.path === "string" ? { path: record.path } : {}),
        ...(typeof record.line === "number" ? { line: record.line } : {}),
        ...(typeof record.side === "string" ? { side: record.side } : {}),
        ...(typeof record.start_line === "number" ? { startLine: record.start_line } : {}),
        ...(typeof record.start_side === "string" ? { startSide: record.start_side } : {}),
        ...(typeof record.commit_id === "string" ? { commitId: record.commit_id } : {}),
        ...(typeof record.html_url === "string" ? { url: record.html_url } : {}),
        ...(typeof record.diff_hunk === "string" ? { diffHunk: record.diff_hunk } : {}),
        ...(typeof (record.user as Record<string, unknown> | undefined)?.login === "string"
          ? { authorLogin: String((record.user as Record<string, unknown>).login) }
          : {}),
      });
    }

    return comments;
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
    const issue = this.db.issues.getIssueByPrNumber(prNumber);
    if (!issue) return;
    if (!this.isPatchRelayOwnedPr(issue)) return;

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
      const run = this.db.runs.getRunById(issue.activeRunId);
      if (run?.threadId && run.turnId) {
        try {
          await this.codex.steerTurn({
            threadId: run.threadId,
            turnId: run.turnId,
            input: `GitHub PR comment from ${author}:\n\n${body}`,
          });
          this.logger.info({ issueKey: issue.issueKey, author }, "Forwarded GitHub PR comment to active run");
          return;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to forward GitHub PR comment");
        }
      }
    }

    this.db.issueSessions.appendIssueSessionEvent({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType: "followup_comment",
      eventJson: JSON.stringify({ body, author }),
    });
    this.enqueuePendingSessionWake(issue.projectId, issue.linearIssueId);
  }

  private async readGitHubErrorResponse(response: Response): Promise<string> {
    try {
      const payload = await response.json() as { message?: unknown; errors?: unknown };
      if (typeof payload?.message === "string" && payload.message.trim()) {
        return payload.message.trim();
      }
      if (payload?.errors !== undefined) {
        return JSON.stringify(payload.errors);
      }
    } catch {
      // Fall through to status text.
    }

    return response.statusText || `GitHub API responded with ${response.status}`;
  }

  private peekPendingSessionWakeRunType(projectId: string, issueId: string): string | undefined {
    return this.db.issueSessions.peekIssueSessionWake(projectId, issueId)?.runType;
  }

  private enqueuePendingSessionWake(projectId: string, issueId: string): string | undefined {
    const wake = this.db.issueSessions.peekIssueSessionWake(projectId, issueId);
    if (!wake) {
      return undefined;
    }
    this.enqueueIssue(projectId, issueId);
    return wake.runType;
  }

  private isPatchRelayOwnedPr(issue: IssueRecord): boolean {
    const author = normalizeAuthorLogin(issue.prAuthorLogin);
    if (author) {
      if (this.patchRelayAuthorLogins.size > 0) {
        return this.patchRelayAuthorLogins.has(author);
      }
      return author.includes("patchrelay");
    }
    // Transitional fallback for rows written before author tracking existed.
    return issue.prNumber !== undefined && issue.branchOwner === "patchrelay";
  }
}

function normalizeAuthorLogin(login: string | undefined): string | undefined {
  const normalized = login?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function resolvePatchRelayAuthorLoginsFromEnv(): string[] {
  return [
    process.env.PATCHRELAY_GITHUB_BOT_LOGIN,
    process.env.PATCHRELAY_GITHUB_BOT_NAME,
  ]
    .flatMap((value) => (value ?? "").split(","))
    .map((value) => normalizeAuthorLogin(value))
    .filter((value): value is string => Boolean(value));
}

function buildGitHubReviewUrl(
  repoFullName: string | undefined,
  prNumber: number | undefined,
  reviewId: number | undefined,
): string | undefined {
  if (!repoFullName || prNumber === undefined || reviewId === undefined) {
    return undefined;
  }
  return `https://github.com/${repoFullName}/pull/${prNumber}#pullrequestreview-${reviewId}`;
}

function resolveCheckClass(
  checkName: string | undefined,
  project: ProjectConfig | undefined,
): "code" | "review" | "gate" {
  if (!checkName || !project) return "code";
  if ((project.reviewChecks ?? []).some((name) => checkName.includes(name))) return "review";
  if ((project.gateChecks ?? []).some((name) => checkName.includes(name))) return "gate";
  return "code";
}
