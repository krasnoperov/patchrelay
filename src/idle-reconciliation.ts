import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { TERMINAL_STATES } from "./factory-state.ts";
import {
  CLEARED_FAILURE_PROVENANCE,
  mayClearFailureProvenance,
  type ObservedProvenanceEvidence,
} from "./failure-provenance.ts";
import { deriveFactoryStateFromPrFacts, type CurrentIssueFacts, type ObservedPrFacts } from "./pr-facts-derivation.ts";
import type { AppConfig } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import {
  DEPLOY_WATCH_TIMEOUT_MS,
  evaluateDeploy,
  isDeployTrackingEnabled,
  type DeployEvaluator,
} from "./post-merge-deploy.ts";
import {
  buildBranchUpkeepContext,
  buildFailureContext,
  getGateCheckNames,
  hasCompletedReviewQuillVerdict,
  hasFailureProvenance,
  isDuplicateRepairAttempt,
  isFailingCheckStatus,
  isReviewDecisionApproved,
  isReviewDecisionReviewRequired,
} from "./idle-reconciliation-helpers.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { deriveGateCheckStatusFromRollup } from "./github-rollup.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import { serializeRunContext, type RunContext } from "./run-context.ts";
import { buildClosedPrCleanupFields, resolveClosedPrDisposition } from "./pr-state.ts";
import { getReviewFixBudget } from "./run-budgets.ts";
import { queueSettledOrchestrationIssue } from "./orchestration-parent-wake.ts";
import { fetchPullRequestSnapshot } from "./reconcile-pr-fetch.ts";
import { buildPrStateUpdates } from "./reconcile-pr-state-updates.ts";
import { buildRepairWakeDedupeKey, buildRequestedChangesWakeIdentity, reactiveWakeEventType } from "./reactive-wake-keys.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";
import { execCommand } from "./utils.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import { LinearIssueProjectionService } from "./linear-issue-projection.ts";
import type { LinearClientProvider } from "./types.ts";
import { TerminalWakeReconciler } from "./terminal-wake-reconciler.ts";

const BLOCKED_DEPENDENCY_REFRESH_SUCCESS_BACKOFF_MS = 60_000;
const BLOCKED_DEPENDENCY_REFRESH_FAILURE_BACKOFF_MS = 5 * 60_000;

const WRITER = "idle-reconciliation";

export class IdleIssueReconciler {
  private readonly blockedDependencyRefreshAfter = new Map<string, number>();
  private readonly terminalWakeReconciler: TerminalWakeReconciler;
  private readonly linearIssueProjection: LinearIssueProjectionService | undefined;

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly config: AppConfig,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    // Injectable for tests; production uses the real `gh`-backed watcher.
    private readonly deployEvaluator: DeployEvaluator = evaluateDeploy,
    private readonly syncIssue?: (issue: IssueRecord) => void | Promise<void>,
    private readonly linearProvider?: LinearClientProvider,
  ) {
    this.terminalWakeReconciler = new TerminalWakeReconciler(db, logger);
    this.linearIssueProjection = linearProvider
      ? new LinearIssueProjectionService(db, linearProvider, logger)
      : undefined;
  }

  async reconcile(): Promise<void> {
    // Wrap the entire reconcile pass in a dispatcher tick. Every
    // dispatchIfWakePending / recordEventAndDispatch call inside the
    // callback automatically shares one dedupe Set, so a single pass
    // produces at most one enqueue per issue even when several sub-
    // passes detect the same wake. SerialWorkQueue would dedupe anyway,
    // but keeping the call log clean makes orchestrator behaviour
    // easier to inspect from tests and the operator feed.
    return this.wakeDispatcher.withTick(() => this.reconcileBody());
  }

  private async reconcileBody(): Promise<void> {
    for (const issue of this.db.issues.listIdleNonTerminalIssues()) {
      if (issue.prState === "merged") {
        await this.handleMergedIssue(issue);
        continue;
      }

      if (issue.lastGitHubFailureSource === "queue_eviction") {
        await this.routeFailedIssue(issue);
        continue;
      }

      if (issue.lastGitHubFailureSource === "branch_ci") {
        await this.routeFailedIssue(issue);
        continue;
      }

      if (issue.prReviewState === "approved" && !isFailingCheckStatus(issue.prCheckStatus)) {
        if (issue.prNumber) {
          await this.reconcileFromGitHub(issue);
        } else {
          // No PR to poll means no fresh GitHub evidence — provenance may
          // only be cleared when nothing concrete is recorded to preserve.
          const clear = hasFailureProvenance(issue) && mayClearFailureProvenance(issue, {});
          if (issue.factoryState !== "awaiting_queue" || clear) {
            this.advanceIdleIssue(issue, "awaiting_queue", clear ? { clearFailureProvenance: true } : {});
          }
        }
        continue;
      }

      if (isFailingCheckStatus(issue.prCheckStatus)) {
        await this.routeFailedIssue(issue);
        continue;
      }

      // Probe GitHub for idle issues with PRs: detect missed reviews,
      // merge conflicts, and orphaned repair states.
      if (issue.prNumber) {
        await this.reconcileFromGitHub(issue);
      }
    }

    for (const issue of this.db.issues.listTerminalIssuesNeedingGitHubProbe()) {
      if (!this.shouldProbeTerminalIssueFromGitHub(issue)) continue;
      await this.reconcileFromGitHub(issue);
    }

    this.terminalWakeReconciler.reconcile();

    for (const issue of this.db.issues.listBlockedDelegatedIssues()) {
      if (!issue.delegatedToPatchRelay) continue;
      const dependencyKey = `${issue.projectId}::${issue.linearIssueId}`;
      const refreshAfter = this.blockedDependencyRefreshAfter.get(dependencyKey);
      if (this.linearIssueProjection) {
        if (refreshAfter === undefined || refreshAfter <= Date.now()) {
          const refresh = await this.linearIssueProjection.refreshIssue(issue.projectId, issue.linearIssueId);
          this.blockedDependencyRefreshAfter.set(
            dependencyKey,
            Date.now() + (refresh.refreshed ? BLOCKED_DEPENDENCY_REFRESH_SUCCESS_BACKOFF_MS : BLOCKED_DEPENDENCY_REFRESH_FAILURE_BACKOFF_MS),
          );
          if (!refresh.refreshed) {
            continue;
          }
        }
      }
      const unresolved = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      if (unresolved === 0) {
        this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
          eventType: "delegated",
          dedupeKey: `delegated:${issue.linearIssueId}`,
        });
      }
    }

    const now = Date.now();
    for (const issue of this.db.issues.listOrchestrationIssuesWithSettleDeadline()) {
      if (
        issue.issueClass !== "orchestration"
        || !issue.orchestrationSettleUntil
        || issue.activeRunId !== undefined
        || !issue.delegatedToPatchRelay
      ) {
        continue;
      }
      const settleAt = Date.parse(issue.orchestrationSettleUntil);
      if (!Number.isFinite(settleAt) || settleAt > now) {
        continue;
      }
      queueSettledOrchestrationIssue({
        db: this.db,
        issue,
        wakeDispatcher: this.wakeDispatcher,
      });
    }

    // Safety net: re-enqueue any idle delegated issue that still has
    // unprocessed session events. Until this pass existed, a single
    // dropped enqueueIssue (lease race, in-memory queue lost across
    // restart) left review_fix / ci_repair / queue_repair wakes stuck
    // for hours until an external event re-poked the issue. The
    // surrounding withTick scope ensures the call log shows at most one
    // enqueue per issue per pass even when earlier passes also queued.
    for (const issue of this.db.issues.listIdleIssuesWithPendingWake()) {
      this.wakeDispatcher.dispatchIfWakePending(issue.projectId, issue.linearIssueId);
    }
  }

  private shouldProbeTerminalIssueFromGitHub(issue: IssueRecord): boolean {
    if (issue.prNumber === undefined) return false;
    if (issue.activeRunId !== undefined) return false;
    if (issue.pendingRunType !== undefined) return false;
    // A merged PR cannot be un-merged: never re-probe it back toward the
    // queue. This matters for deploy-failed issues (escalated while
    // prState === "merged") — recovery-to-awaiting_queue would be wrong.
    if (issue.prState === "merged") return false;
    return issue.factoryState === "escalated" || issue.factoryState === "failed";
  }

  // PR3: route a merged PR either into post-merge deploy tracking or
  // straight to done. Called from both the idle pass and the GitHub
  // reconcile path, so the deploying-vs-done decision lives in one place.
  private async handleMergedIssue(issue: IssueRecord): Promise<void> {
    if (issue.factoryState === "deploying") {
      await this.watchDeploy(issue);
      return;
    }
    // Already finalized (done/escalated/failed) — never re-open it.
    if (TERMINAL_STATES.has(issue.factoryState)) return;
    const project = this.config.projects.find((candidate) => candidate.id === issue.projectId);
    if (isDeployTrackingEnabled(project)) {
      if (this.advanceIdleIssue(issue, "deploying", { clearFailureProvenance: true }) !== "skipped") {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            deployStartedAt: new Date().toISOString(),
          },
        });
      }
    } else {
      this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
    }
  }

  // Poll the project's deploy workflow for a merged issue sitting in
  // `deploying`: success → done, failure → escalate, still running → wait
  // (with a timeout backstop so a never-arriving deploy can't strand it).
  private async watchDeploy(issue: IssueRecord): Promise<void> {
    const project = this.config.projects.find((candidate) => candidate.id === issue.projectId);
    const protocol = resolveMergeQueueProtocol(project);
    const workflowName = protocol.deployWorkflowName;
    const repoFullName = protocol.repoFullName;
    if (!workflowName || !repoFullName) {
      // Misconfigured / tracking disabled after entering — don't strand it.
      this.finishDeploy(issue, "done");
      return;
    }
    const since = issue.deployStartedAt ?? issue.updatedAt;
    const outcome = await this.deployEvaluator({
      repoFullName,
      workflowName,
      baseBranch: protocol.baseBranch ?? "main",
      sinceIso: since,
      logger: this.logger,
    });
    if (outcome === "succeeded") {
      this.logger.info({ issueKey: issue.issueKey, prNumber: issue.prNumber }, "Deploy succeeded; completing issue");
      this.finishDeploy(issue, "done");
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "done",
        status: "deployed",
        summary: `Deploy succeeded for PR #${issue.prNumber}`,
      });
      return;
    }
    if (outcome === "failed") {
      this.logger.warn({ issueKey: issue.issueKey, prNumber: issue.prNumber }, "Deploy failed; escalating for operator attention");
      this.finishDeploy(issue, "escalated");
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "deploying",
        status: "deploy_failed",
        summary: `Deploy failed for PR #${issue.prNumber}; needs operator attention`,
      });
      return;
    }
    // Still pending — apply the timeout backstop.
    const sinceMs = Date.parse(since);
    if (Number.isFinite(sinceMs) && Date.now() - sinceMs > DEPLOY_WATCH_TIMEOUT_MS) {
      this.logger.warn(
        { issueKey: issue.issueKey, prNumber: issue.prNumber },
        "Deploy not observed within timeout; completing issue (change is already on main)",
      );
      this.finishDeploy(issue, "done");
    }
  }

  private finishDeploy(issue: IssueRecord, state: "done" | "escalated"): void {
    if (this.advanceIdleIssue(issue, state, state === "done" ? { clearFailureProvenance: true } : undefined) === "skipped") {
      return;
    }
    this.db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        deployStartedAt: null,
      },
    });
  }

  advanceIdleIssue(
    issue: IssueRecord,
    newState: FactoryState,
    options?: {
      pendingRunType?: RunType;
      pendingRunContext?: RunContext;
      clearFailureProvenance?: boolean;
    },
  ): "applied" | "noop" | "skipped" {
    if (issue.factoryState === newState && !options?.pendingRunType && !options?.clearFailureProvenance) {
      return "noop";
    }
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: issue.version,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        factoryState: newState,
        ...((options?.pendingRunType || newState === "awaiting_queue" || newState === "delegated" || newState === "done")
          ? {
              pendingRunType: null,
              pendingRunContextJson: null,
            }
          : {}),
        ...(options?.clearFailureProvenance
          ? { ...CLEARED_FAILURE_PROVENANCE }
          : {}),
      },
      // A writer that landed mid-tick (almost always a webhook) is newer
      // truth than this pass's read; skip and let the next tick re-derive.
      onConflict: () => undefined,
    });
    if (commit.outcome !== "applied") {
      this.logger.info(
        { issueKey: issue.issueKey, from: issue.factoryState, to: newState, outcome: commit.outcome },
        "Reconciliation: skipped advancing idle issue after a concurrent write",
      );
      return "skipped";
    }
    this.logger.info(
      { issueKey: issue.issueKey, from: issue.factoryState, to: newState, pendingRunType: options?.pendingRunType },
      "Reconciliation: advancing idle issue",
    );
    const updatedIssue = commit.issue;
    if (this.syncIssue) {
      void Promise.resolve(this.syncIssue(updatedIssue)).catch((error: unknown) => {
        this.logger.warn(
          { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
          "Failed to sync Linear workflow state after idle reconciliation",
        );
      });
    }
    if (options?.pendingRunType) {
      this.recordWakeEvent(issue, options.pendingRunType, options.pendingRunContext, "idle_reconciliation");
    }
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: newState,
      status: "reconciled",
      summary: `Reconciliation: ${issue.factoryState} \u2192 ${newState}`,
    });
    // The dispatcher's recordEventAndDispatch in recordWakeEvent already
    // handles the enqueue when no run is in flight, so no extra poke
    // is needed here.
    return "applied";
  }

  private recordWakeEvent(
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureHeadSha" | "lastGitHubFailureSignature">,
    runType: RunType,
    context?: RunContext,
    dedupeScope = "idle_reconciliation",
  ): void {
    const eventType = reactiveWakeEventType(runType);
    let dedupeKey: string;
    if (runType === "queue_repair" || runType === "ci_repair") {
      dedupeKey = buildRepairWakeDedupeKey({
        scope: dedupeScope,
        runType,
        linearIssueId: issue.linearIssueId,
        signature: issue.lastGitHubFailureSignature,
        prHeadSha: issue.prHeadSha,
        failureHeadSha: issue.lastGitHubFailureHeadSha,
      });
    } else if (runType === "review_fix" || runType === "branch_upkeep") {
      dedupeKey = buildRequestedChangesWakeIdentity({
        linearIssueId: issue.linearIssueId,
        runType,
        headSha: issue.prHeadSha,
      }).dedupeKey;
    } else {
      dedupeKey = `${dedupeScope}:implementation:${issue.linearIssueId}`;
    }
    const requestedChangesIdentity = eventType === "review_changes_requested"
      ? buildRequestedChangesWakeIdentity({
          linearIssueId: issue.linearIssueId,
          runType: runType === "branch_upkeep" ? "branch_upkeep" : "review_fix",
          headSha: issue.prHeadSha,
        })
      : undefined;
    this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType,
      ...(context || requestedChangesIdentity ? {
        eventJson: serializeRunContext({
          ...context,
          ...(requestedChangesIdentity ? {
            requestedChangesCoalesceKey: requestedChangesIdentity.coalesceKey,
            ...(requestedChangesIdentity.headSha ? { requestedChangesHeadSha: requestedChangesIdentity.headSha } : {}),
          } : {}),
        }, "reconciliation wake context"),
      } : {}),
      dedupeKey,
    });
  }

  private async routeFailedIssue(issue: IssueRecord): Promise<void> {
    if (!issue.delegatedToPatchRelay) {
      return;
    }
    issue = await this.refreshMissingFailureProvenance(issue);
    issue = await this.reclassifyStaleBranchFailure(issue);
    const latestRun = this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const ignoreDuplicateAttempt = latestRun?.status === "failed"
      && latestRun.failureReason === "Codex turn was interrupted";
    const reactiveIntent = deriveIssueSessionReactiveIntent({
      prNumber: issue.prNumber,
      prState: issue.prState,
      prHeadSha: issue.prHeadSha,
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
      lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
      latestFailureSource: issue.lastGitHubFailureSource,
    });

    if (!reactiveIntent && issue.factoryState === "awaiting_queue") {
      const inferred = await this.inferFailureSourceFromGitHub(issue) ?? "branch_ci";
      const inferRunType = inferred === "queue_eviction" ? "queue_repair" : "ci_repair";
      const inferState = inferred === "queue_eviction" ? "repairing_queue" : "repairing_ci";
      this.logger.info(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, inferred },
        "Inferred failure provenance for awaiting_queue issue",
      );
      const pendingRunContext = buildFailureContext(issue);
      this.advanceIdleIssue(issue, inferState as never, {
        pendingRunType: inferRunType,
        ...(pendingRunContext ? { pendingRunContext } : {}),
      });
      return;
    }

    if (!reactiveIntent) {
      return;
    }

    const pendingRunContext = buildFailureContext(issue);
    const duplicateRepair = reactiveIntent.runType !== "review_fix"
      && !ignoreDuplicateAttempt
      && isDuplicateRepairAttempt(issue, pendingRunContext);
    if (duplicateRepair) {
      this.advanceIdleIssue(issue, reactiveIntent.compatibilityFactoryState);
    } else {
      this.advanceIdleIssue(issue, reactiveIntent.compatibilityFactoryState, {
        pendingRunType: reactiveIntent.runType,
        ...(pendingRunContext ? { pendingRunContext } : {}),
      });
    }
  }

  private async refreshMissingFailureProvenance(issue: IssueRecord): Promise<IssueRecord> {
    if (issue.lastGitHubFailureSource || !issue.prNumber || !isFailingCheckStatus(issue.prCheckStatus)) {
      return issue;
    }
    const inferred = await this.inferFailureSourceFromGitHub(issue);
    if (!inferred) return issue;
    const protocol = this.getIssueProtocol(issue);
    const failureHeadSha = issue.lastGitHubFailureHeadSha ?? issue.lastGitHubCiSnapshotHeadSha ?? issue.prHeadSha ?? null;
    const checkName = inferred === "queue_eviction"
      ? issue.lastGitHubFailureCheckName ?? protocol.evictionCheckName
      : issue.lastGitHubFailureCheckName ?? null;
    const failureSignature = issue.lastGitHubFailureSignature
      ?? (inferred === "queue_eviction" && failureHeadSha && checkName
        ? ["queue_eviction", failureHeadSha, checkName].join("::")
        : null);
    // Inference from a stale read must never overwrite provenance a
    // concurrent webhook just recorded — skip on conflict and continue
    // with the fresh row.
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: issue.version,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubFailureSource: inferred,
        ...(failureHeadSha ? { lastGitHubFailureHeadSha: failureHeadSha } : {}),
        ...(checkName ? { lastGitHubFailureCheckName: checkName } : {}),
        ...(failureSignature ? { lastGitHubFailureSignature: failureSignature } : {}),
      },
      onConflict: () => undefined,
    });
    if (commit.outcome !== "applied") {
      return (commit.outcome === "conflict_skipped" ? commit.issue : undefined) ?? issue;
    }
    this.logger.info(
      { issueKey: issue.issueKey, prNumber: issue.prNumber, inferred, factoryState: issue.factoryState },
      "Recovered missing failure provenance from GitHub state",
    );
    return commit.issue;
  }

  private async reclassifyStaleBranchFailure(issue: IssueRecord): Promise<IssueRecord> {
    const downstreamOwned = issue.factoryState === "awaiting_queue" || issue.prReviewState === "approved";
    if (issue.lastGitHubFailureSource !== "branch_ci" || !downstreamOwned) {
      return issue;
    }
    const inferred = await this.inferFailureSourceFromGitHub(issue);
    if (inferred !== "queue_eviction") {
      return issue;
    }
    const protocol = this.getIssueProtocol(issue);
    const failureHeadSha = issue.lastGitHubFailureHeadSha ?? issue.lastGitHubCiSnapshotHeadSha ?? issue.prHeadSha ?? null;
    const checkName = issue.lastGitHubFailureCheckName ?? protocol.evictionCheckName;
    const failureSignature = issue.lastGitHubFailureSignature
      ?? (failureHeadSha && checkName ? ["queue_eviction", failureHeadSha, checkName].join("::") : null);
    const commit = this.db.issueSessions.commitIssueState({
      writer: WRITER,
      expectedVersion: issue.version,
      update: {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastGitHubFailureSource: "queue_eviction",
        ...(failureHeadSha ? { lastGitHubFailureHeadSha: failureHeadSha } : {}),
        ...(checkName ? { lastGitHubFailureCheckName: checkName } : {}),
        ...(failureSignature ? { lastGitHubFailureSignature: failureSignature } : {}),
      },
      onConflict: () => undefined,
    });
    if (commit.outcome !== "applied") {
      return (commit.outcome === "conflict_skipped" ? commit.issue : undefined) ?? issue;
    }
    this.logger.info(
      { issueKey: issue.issueKey, prNumber: issue.prNumber },
      "Reclassified stale branch failure as queue repair from GitHub state",
    );
    return commit.issue;
  }

  private async inferFailureSourceFromGitHub(issue: IssueRecord): Promise<"queue_eviction" | "branch_ci" | undefined> {
    const project = this.config.projects.find((candidate) => candidate.id === issue.projectId);
    const repoFullName = project?.github?.repoFullName;
    const probeSha = issue.lastGitHubFailureHeadSha ?? issue.lastGitHubCiSnapshotHeadSha ?? issue.prHeadSha;
    if (!repoFullName || !issue.prNumber || !probeSha) return undefined;
    const protocol = this.getIssueProtocol(issue);
    try {
      const { stdout } = await execCommand("gh", [
        "api",
        `repos/${repoFullName}/commits/${probeSha}/check-runs`,
        "--jq", `.check_runs[] | select(.name == "${protocol.evictionCheckName}" and .conclusion == "failure") | .name`,
      ], { timeoutMs: 10_000 });
      if (stdout.trim().length > 0) return "queue_eviction";
    } catch {
      // Fall through to a PR-level probe. Preemptive conflicts can require
      // queue repair even when no merge-steward eviction check-run exists yet.
    }
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", repoFullName,
        "--json", "mergeable,mergeStateStatus,labels",
      ], { timeoutMs: 10_000 });
      const pr = JSON.parse(stdout) as {
        mergeable?: string;
        mergeStateStatus?: string;
      };
      const downstreamOwned = issue.factoryState === "awaiting_queue" || issue.prReviewState === "approved";
      if ((pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY")
        && downstreamOwned) {
        return "queue_eviction";
      }
      if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
        return undefined;
      }
    } catch {
      return issue.factoryState === "awaiting_queue" || issue.prReviewState === "approved" ? "branch_ci" : undefined;
    }
    return "branch_ci";
  }

  private getIssueProtocol(issue: Pick<IssueRecord, "projectId">) {
    const project = this.config.projects.find((candidate) => candidate.id === issue.projectId);
    return resolveMergeQueueProtocol(project);
  }

  private async reconcileFromGitHub(issue: IssueRecord): Promise<void> {
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project?.github?.repoFullName || !issue.prNumber) return;
    const prNumber = issue.prNumber;
    const snapshot = await fetchPullRequestSnapshot(project.github.repoFullName, prNumber);
    if (!snapshot.ok) {
      this.logger.debug(
        { issueKey: issue.issueKey, error: snapshot.error.message },
        "Failed to query GitHub PR state during reconciliation",
      );
      if (issue.prReviewState === "approved") {
        // The poll failed, so there is no fresh evidence: never clear
        // recorded failure provenance on this path (a green-looking local
        // row must not swallow a pending repair).
        const clear = hasFailureProvenance(issue) && mayClearFailureProvenance(issue, {});
        if (issue.factoryState !== "awaiting_queue" || clear) {
          this.advanceIdleIssue(issue, "awaiting_queue", clear ? { clearFailureProvenance: true } : {});
        }
      }
      return;
    }
    const pr = snapshot.pr;
    {
      const previousHeadSha = issue.prHeadSha;
      const gateCheckNames = getGateCheckNames(project);
      const gateCheckStatus = deriveGateCheckStatusFromRollup(pr.statusCheckRollup, gateCheckNames);
      const headAdvanced = Boolean(pr.headRefOid && pr.headRefOid !== previousHeadSha);
      const prState = pr.state === "MERGED" ? "merged" as const : pr.state === "CLOSED" ? "closed" as const : "open" as const;
      // Normalized level observation shared with the webhook path (plan §C1):
      // every factory-state decision below goes through
      // deriveFactoryStateFromPrFacts so both ingestion paths derive the same
      // state from the same facts.
      const observed: ObservedPrFacts = {
        source: "poll",
        prState,
        prNumber,
        ...(pr.reviewDecision ? { reviewDecision: pr.reviewDecision } : {}),
        ...(gateCheckStatus ? { gateCheckStatus } : {}),
        ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
        headAdvanced,
        ...(prState === "closed" ? { closedPrDisposition: resolveClosedPrDisposition(issue) } : {}),
      };
      this.db.workflowObservations.appendObservation({
        projectId: issue.projectId,
        subjectId: issue.linearIssueId,
        source: "github",
        type: "github.pr_reconciled",
        payloadJson: JSON.stringify({
          ...observed,
          repoFullName: project.github.repoFullName,
          mergeable: pr.mergeable,
          mergeStateStatus: pr.mergeStateStatus,
        }),
        dedupeKey: [
          "pr_reconciled",
          project.github.repoFullName,
          prNumber,
          prState,
          pr.headRefOid ?? "",
          pr.reviewDecision ?? "",
          gateCheckStatus ?? "",
          pr.mergeable ?? "",
          pr.mergeStateStatus ?? "",
        ].join(":"),
      });
      const currentFacts = (record: IssueRecord): CurrentIssueFacts => ({
        factoryState: record.factoryState,
        prReviewState: record.prReviewState,
        activeRunId: record.activeRunId,
      });
      // Evidence for the provenance rule: the polled head is current truth.
      const provenanceEvidence: ObservedProvenanceEvidence = {
        prState,
        ...(pr.headRefOid ? { headSha: pr.headRefOid } : {}),
        headIsCurrentTruth: true,
        ...(gateCheckStatus ? { gateCheckStatus } : {}),
      };
      const factsCommit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...buildPrStateUpdates(pr, gateCheckStatus, gateCheckNames[0] ?? "verify"),
          // A newly observed head is the poll-side equivalent of a lost
          // pr_synchronize: the webhook path resets the repair budgets for
          // the fresh head, so re-derivation must too — otherwise the new
          // head inherits the old head's consumed budget and escalates
          // earlier. Provenance clearing stays governed by
          // mayClearFailureProvenance at the advance sites below.
          ...(headAdvanced ? { ciRepairAttempts: 0, queueRepairAttempts: 0 } : {}),
        },
      });
      // Continue the pass with the refreshed row so later version-checked
      // writes don't see our own facts write as a conflict.
      if (factsCommit.outcome === "applied") {
        issue = factsCommit.issue;
      }
      if (pr.state === "MERGED") {
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" },
        });
        const merged = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? { ...issue, prState: "merged" };
        await this.handleMergedIssue(merged);
        return;
      }
      if (pr.state === "CLOSED") {
        // State decision shared with the webhook path; a closed PR is always
        // newer evidence than any recorded failure, so clearing is allowed.
        const closedState = deriveFactoryStateFromPrFacts(observed, currentFacts(issue));
        const closedCommit = this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            prState: "closed",
            ...buildClosedPrCleanupFields(),
          },
        });
        if (closedCommit.outcome === "applied") {
          issue = closedCommit.issue;
        }
        if (closedState === "done") {
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber },
            "Reconciliation: PR was closed for an already completed issue; preserving done state",
          );
          this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
          return;
        }
        if (closedState === undefined) {
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber, factoryState: issue.factoryState },
            "Reconciliation: PR was closed on a terminal issue; preserving terminal state",
          );
          return;
        }
        if (issue.delegatedToPatchRelay) {
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber },
            "Reconciliation: PR was closed on unfinished delegated work, re-delegating for implementation",
          );
          this.advanceIdleIssue(issue, "delegated" as never, {
            pendingRunType: "implementation",
            clearFailureProvenance: true,
          });
        } else {
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber },
            "Reconciliation: PR was closed while undelegated; preserving paused local-work state",
          );
          this.advanceIdleIssue(issue, "delegated", { clearFailureProvenance: true });
        }
        return;
      }

      if (issue.factoryState !== "awaiting_input"
        && (issue.factoryState === "escalated" || issue.factoryState === "failed")) {
        const terminalRecoveryState = deriveFactoryStateFromPrFacts(observed, currentFacts(issue));
        if (terminalRecoveryState) {
          this.logger.info(
            {
              issueKey: issue.issueKey,
              prNumber: issue.prNumber,
              from: issue.factoryState,
              to: terminalRecoveryState,
              gateCheckStatus,
              reviewDecision: pr.reviewDecision,
              headAdvanced,
            },
            "Reconciliation: recovered terminal issue from newer GitHub truth",
          );
          const clear = mayClearFailureProvenance(issue, provenanceEvidence);
          this.advanceIdleIssue(issue, terminalRecoveryState, clear ? { clearFailureProvenance: true } : {});
          return;
        }
      }

      if (issue.delegatedToPatchRelay
        && isReviewDecisionReviewRequired(pr.reviewDecision)
        && gateCheckStatus === "success"
        && hasCompletedReviewQuillVerdict(pr.statusCheckRollup)) {
        this.logger.warn(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, reviewDecision: pr.reviewDecision },
          "Reconciliation: review-quill completed without a decisive GitHub review; escalating for operator input",
        );
        this.advanceIdleIssue(issue, "awaiting_input");
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "awaiting_input",
          status: "non_decisive_review",
          summary: `PR #${issue.prNumber} needs operator input: review-quill finished but GitHub still requires review`,
        });
        return;
      }

      const downstreamOwned = issue.factoryState === "awaiting_queue" || issue.prReviewState === "approved" || pr.reviewDecision === "APPROVED";
      const mergeConflictDetected = pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
      const refreshedIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
      const reactiveIntent = deriveIssueSessionReactiveIntent({
        prNumber: refreshedIssue.prNumber,
        prState: refreshedIssue.prState,
        prHeadSha: refreshedIssue.prHeadSha,
        prReviewState: refreshedIssue.prReviewState,
        prCheckStatus: refreshedIssue.prCheckStatus,
        lastBlockingReviewHeadSha: refreshedIssue.lastBlockingReviewHeadSha,
        latestFailureSource: refreshedIssue.lastGitHubFailureSource,
        mergeConflictDetected,
        downstreamOwned,
      });
      if (issue.delegatedToPatchRelay
        && (issue.factoryState === "escalated" || issue.factoryState === "failed")
        && (reactiveIntent?.runType === "review_fix" || reactiveIntent?.runType === "branch_upkeep")) {
        const reviewFixBudget = getReviewFixBudget(project);
        if (issue.reviewFixAttempts >= reviewFixBudget) {
          this.logger.debug(
            {
              issueKey: issue.issueKey,
              prNumber: issue.prNumber,
              from: issue.factoryState,
              runType: reactiveIntent.runType,
              reviewFixAttempts: issue.reviewFixAttempts,
              reviewFixBudget,
            },
            "Reconciliation: leaving terminal requested-changes issue escalated because the repair budget is exhausted",
          );
          return;
        }
        const pendingRunContext = reactiveIntent.runType === "branch_upkeep"
          ? buildBranchUpkeepContext(
              prNumber,
              project.github?.baseBranch ?? "main",
              pr.mergeStateStatus,
              pr.headRefOid,
            )
          : undefined;
        this.logger.info(
          {
            issueKey: issue.issueKey,
            prNumber: issue.prNumber,
            from: issue.factoryState,
            runType: reactiveIntent.runType,
            mergeStateStatus: pr.mergeStateStatus,
          },
          "Reconciliation: recovered terminal requested-changes issue from GitHub truth",
        );
        this.advanceIdleIssue(issue, reactiveIntent.compatibilityFactoryState, {
          pendingRunType: reactiveIntent.runType,
          ...(pendingRunContext ? { pendingRunContext } : {}),
          ...(mayClearFailureProvenance(issue, provenanceEvidence) ? { clearFailureProvenance: true } : {}),
        });
        return;
      }
      if (
        issue.delegatedToPatchRelay
        && reactiveIntent?.runType === "review_fix"
      ) {
        this.logger.info(
          {
            issueKey: issue.issueKey,
            prNumber: issue.prNumber,
            from: issue.factoryState,
            runType: reactiveIntent.runType,
          },
          "Reconciliation: re-queued requested-changes follow-up from GitHub truth",
        );
        this.advanceIdleIssue(
          issue,
          reactiveIntent.compatibilityFactoryState,
          mayClearFailureProvenance(issue, provenanceEvidence)
            ? { clearFailureProvenance: true }
            : undefined,
        );
        const currentIssue = this.db.issues.getIssue(issue.projectId, issue.linearIssueId);
        if (currentIssue) {
          reconcileWorkflowTasksForIssue(this.db, currentIssue);
          this.wakeDispatcher.dispatchIfWakePending(currentIssue.projectId, currentIssue.linearIssueId);
        }
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: reactiveIntent.compatibilityFactoryState,
          status: "review_fix_queued",
          summary: `PR #${issue.prNumber} still has requested changes on the current head, dispatching review fix`,
        });
        return;
      }
      if (issue.delegatedToPatchRelay && reactiveIntent?.runType === "branch_upkeep" && mergeConflictDetected) {
        this.logger.info(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus },
          "Reconciliation: PR still needs branch upkeep after requested changes",
        );
        this.advanceIdleIssue(issue, reactiveIntent.compatibilityFactoryState, {
          pendingRunType: reactiveIntent.runType,
          pendingRunContext: buildBranchUpkeepContext(
            prNumber,
            project.github?.baseBranch ?? "main",
            pr.mergeStateStatus,
            pr.headRefOid,
          ),
        });
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: reactiveIntent.compatibilityFactoryState,
          status: "branch_upkeep_queued",
          summary: `PR #${issue.prNumber} is still dirty after requested changes, dispatching branch upkeep`,
        });
        return;
      }
      if (issue.delegatedToPatchRelay && reactiveIntent?.runType === "queue_repair" && mergeConflictDetected) {
        this.logger.info(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable },
          "Reconciliation: PR needs queue repair from fresh GitHub truth",
        );
        this.advanceIdleIssue(issue, reactiveIntent.compatibilityFactoryState, {
          pendingRunType: reactiveIntent.runType,
          pendingRunContext: {
            source: "idle_reconciliation",
            failureReason: "merge_conflict_detected",
            failureSignature: `conflict:${issue.prNumber}`,
          },
        });
        this.feed?.publish({
          level: "warn",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: reactiveIntent.compatibilityFactoryState,
          status: "conflict_detected",
          summary: `PR #${issue.prNumber} has merge conflicts with main, dispatching rebase`,
        });
        return;
      }
      if (isReviewDecisionApproved(pr.reviewDecision)) {
        const reviewCommit = this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            prReviewState: "approved",
          },
        });
        // Continue with the refreshed row so the version-checked advance
        // below doesn't see our own review-state write as a conflict (same
        // pattern as the facts commit above). Without this the advance was
        // conflict-skipped on EVERY pass while the poll succeeded, so a lost
        // review_approved webhook never converged to awaiting_queue.
        if (reviewCommit.outcome === "applied") {
          issue = reviewCommit.issue;
        }
        const approvedState = deriveFactoryStateFromPrFacts(observed, currentFacts(issue));
        if (approvedState === "awaiting_queue") {
          // Provenance survives unless the polled evidence is newer than the
          // recorded failure (head advanced, gate green on the failure head).
          const clear = hasFailureProvenance(issue) && mayClearFailureProvenance(issue, provenanceEvidence);
          if (issue.factoryState !== "awaiting_queue" || clear) {
            this.advanceIdleIssue(issue, "awaiting_queue", clear ? { clearFailureProvenance: true } : undefined);
          }
        }
        return;
      }
      if (mergeConflictDetected) {
        this.logger.debug(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus },
          "Reconciliation: PR is dirty but no automation owner was derived",
        );
      }
    }
  }

}
