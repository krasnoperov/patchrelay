import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { GitHubCiSnapshotRecord, IssueRecord } from "./db-types.ts";
import { resolveFactoryStateFromGitHub, TERMINAL_STATES, type FactoryState } from "./factory-state.ts";
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
  requestMergeQueueAdmission,
  resolveMergeQueueProtocol,
} from "./merge-queue-protocol.ts";
import { buildQueueRepairContextFromEvent } from "./merge-queue-incident.ts";
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

export class GitHubWebhookHandler {
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
    const issue = this.db.getIssueByBranch(event.branchName);
    if (!issue) {
      this.logger.debug({ branchName: event.branchName, triggerEvent: event.triggerEvent }, "GitHub webhook: no matching issue for branch");
      return;
    }

    const project = this.config.projects.find((p) => p.id === issue.projectId);

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
    await this.updateCiSnapshot(issue, event, project);
    await this.updateFailureProvenance(issue, event, project);

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
          const proj = this.config.projects.find((p) => p.id === issue.projectId);
          const protocol = resolveMergeQueueProtocol(proj);
          void requestMergeQueueAdmission({
            issue: transitionedIssue,
            protocol,
            logger: this.logger,
            feed: this.feed,
          });
        }

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
    if (this.isQueueEvictionFailure(freshIssue, event, project) || this.isGateCheckEvent(event, project)) {
      await this.maybeEnqueueReactiveRun(freshIssue, event, project);
    } else if (!isMetadataOnlyCheckEvent(event)) {
      await this.maybeEnqueueReactiveRun(freshIssue, event, project);
    }
  }

  private async updateCiSnapshot(
    issue: IssueRecord,
    event: NormalizedGitHubEvent,
    project?: ProjectConfig,
  ): Promise<void> {
    if (event.triggerEvent === "pr_merged") {
      this.db.upsertIssue({
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
      this.db.upsertIssue({
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
      this.db.upsertIssue({
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

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
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
    if (TERMINAL_STATES.has(issue.factoryState as FactoryState)) return;

    if (event.triggerEvent === "check_failed" && issue.prState === "open") {
      // External merge queue eviction: react only to the configured check
      // name, not to any CI failure. Regular CI failures still get ci_repair.
      if (this.isQueueEvictionFailure(issue, event, project)) {
        const queueRepairContext = buildQueueRepairContextFromEvent(event);
        const failureContext = this.buildQueueFailureContext(issue, event, queueRepairContext);
        if (this.hasDuplicatePendingReactiveRun(issue, "queue_repair", failureContext)) {
          return;
        }
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          pendingRunType: "queue_repair",
          pendingRunContextJson: JSON.stringify({
            ...queueRepairContext,
            ...failureContext,
          }),
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
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
        this.logger.info({ issueKey: issue.issueKey, checkName: event.checkName }, "Queue eviction detected, enqueued queue repair");
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "repairing_queue",
          status: "queue_repair_queued",
          summary: `Queue repair queued after external failure from ${event.checkName}`,
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
        const snapshot = this.getRelevantCiSnapshot(issue, event);
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          pendingRunType: "ci_repair",
          pendingRunContextJson: JSON.stringify({
            ...failureContext,
            checkClass: resolveCheckClass(failureContext.checkName ?? event.checkName, project),
            ...(snapshot ? { ciSnapshot: snapshot } : {}),
          }),
          lastGitHubFailureSource: "branch_ci",
          lastGitHubFailureHeadSha: failureContext.failureHeadSha ?? null,
          lastGitHubFailureSignature: failureContext.failureSignature ?? null,
          lastGitHubFailureCheckName: failureContext.checkName ?? event.checkName ?? null,
          lastGitHubFailureCheckUrl: failureContext.checkUrl ?? event.checkUrl ?? null,
          lastGitHubFailureContextJson: JSON.stringify(failureContext),
          lastGitHubFailureAt: new Date().toISOString(),
          lastQueueIncidentJson: null,
        });
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
        this.logger.info({ issueKey: issue.issueKey, checkName: failureContext.checkName ?? event.checkName }, "Enqueued CI repair run");
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "repairing_ci",
          status: "ci_repair_queued",
          summary: `CI repair queued for ${failureContext.jobName ?? failureContext.checkName ?? "failed check"}`,
          detail: summarizeGitHubFailureContext(failureContext),
        });
      }
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
      this.db.upsertIssue({
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
      this.db.upsertIssue({
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

    if (issue.pendingRunType === runType && issue.pendingRunContextJson) {
      const existing = safeJsonParse<Record<string, unknown>>(issue.pendingRunContextJson);
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
    return configured.length > 0 ? configured : ["Tests"];
  }

  private getPrimaryGateCheckName(project?: ProjectConfig): string {
    return this.getGateCheckNames(project)[0] ?? "Tests";
  }

  private isGateCheckEvent(event: NormalizedGitHubEvent, project?: ProjectConfig): boolean {
    if (event.eventSource !== "check_run" || !event.checkName) return false;
    const normalized = event.checkName.trim().toLowerCase();
    return this.getGateCheckNames(project).some((entry) => entry.trim().toLowerCase() === normalized);
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
    return issue.factoryState === "awaiting_queue"
      && event.eventSource === "check_run"
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
    const snapshot = this.db.getLatestGitHubCiSnapshot(issue.projectId, issue.linearIssueId);
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
  if ((project.reviewChecks ?? []).some((name) => checkName.includes(name))) return "review";
  if ((project.gateChecks ?? []).some((name) => checkName.includes(name))) return "gate";
  return "code";
}
