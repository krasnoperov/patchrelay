import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { TERMINAL_STATES } from "./factory-state.ts";
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
import { buildClosedPrCleanupFields, resolveClosedPrDisposition } from "./pr-state.ts";
import { getReviewFixBudget } from "./run-budgets.ts";
import { queueSettledOrchestrationIssue } from "./orchestration-parent-wake.ts";
import { fetchPullRequestSnapshot } from "./reconcile-pr-fetch.ts";
import { buildPrStateUpdates } from "./reconcile-pr-state-updates.ts";
import { execCommand } from "./utils.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";

export class IdleIssueReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly config: AppConfig,
    private readonly wakeDispatcher: WakeDispatcher,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
    // Injectable for tests; production uses the real `gh`-backed watcher.
    private readonly deployEvaluator: DeployEvaluator = evaluateDeploy,
  ) {}

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
        } else if (issue.factoryState !== "awaiting_queue") {
          this.advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });
        } else if (hasFailureProvenance(issue)) {
          this.advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });
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

    for (const issue of this.db.issues.listIssues()) {
      if (!this.shouldProbeTerminalIssueFromGitHub(issue)) continue;
      await this.reconcileFromGitHub(issue);
    }

    for (const issue of this.db.issues.listBlockedDelegatedIssues()) {
      if (!issue.delegatedToPatchRelay) continue;
      const unresolved = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      if (unresolved === 0) {
        this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
          eventType: "delegated",
          dedupeKey: `delegated:${issue.linearIssueId}`,
        });
      }
    }

    const now = Date.now();
    for (const issue of this.db.issues.listIssues()) {
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
      this.advanceIdleIssue(issue, "deploying", { clearFailureProvenance: true });
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        deployStartedAt: new Date().toISOString(),
      });
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
    this.advanceIdleIssue(issue, state, state === "done" ? { clearFailureProvenance: true } : undefined);
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      deployStartedAt: null,
    });
  }

  advanceIdleIssue(
    issue: IssueRecord,
    newState: FactoryState,
    options?: {
      pendingRunType?: RunType;
      pendingRunContext?: Record<string, unknown>;
      clearFailureProvenance?: boolean;
    },
  ): void {
    if (issue.factoryState === newState && !options?.pendingRunType && !options?.clearFailureProvenance) {
      return;
    }
    this.logger.info(
      { issueKey: issue.issueKey, from: issue.factoryState, to: newState, pendingRunType: options?.pendingRunType },
      "Reconciliation: advancing idle issue",
    );
    this.db.issues.upsertIssue({
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
        ? {
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
            lastAttemptedFailureAt: null,
          }
        : {}),
    });
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
  }

  private recordWakeEvent(
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "prHeadSha" | "lastGitHubFailureHeadSha" | "lastGitHubFailureSignature">,
    runType: RunType,
    context?: Record<string, unknown>,
    dedupeScope = "idle_reconciliation",
  ): void {
    let eventType: "delegated" | "review_changes_requested" | "settled_red_ci" | "merge_steward_incident";
    let dedupeKey: string;
    if (runType === "queue_repair") {
      eventType = "merge_steward_incident";
      dedupeKey = `${dedupeScope}:queue_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown"}`;
    } else if (runType === "ci_repair") {
      eventType = "settled_red_ci";
      dedupeKey = `${dedupeScope}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown"}`;
    } else if (runType === "review_fix" || runType === "branch_upkeep") {
      eventType = "review_changes_requested";
      dedupeKey = `${dedupeScope}:${runType}:${issue.linearIssueId}:${issue.prHeadSha ?? "unknown"}`;
    } else {
      eventType = "delegated";
      dedupeKey = `${dedupeScope}:implementation:${issue.linearIssueId}`;
    }
    this.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
      eventType,
      ...(context ? { eventJson: JSON.stringify(context) } : {}),
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
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
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
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubFailureSource: inferred,
      ...(failureHeadSha ? { lastGitHubFailureHeadSha: failureHeadSha } : {}),
      ...(checkName ? { lastGitHubFailureCheckName: checkName } : {}),
      ...(failureSignature ? { lastGitHubFailureSignature: failureSignature } : {}),
    });
    const refreshed = this.db.issues.getIssue(issue.projectId, issue.linearIssueId);
    if (!refreshed) return issue;
    this.logger.info(
      { issueKey: issue.issueKey, prNumber: issue.prNumber, inferred, factoryState: issue.factoryState },
      "Recovered missing failure provenance from GitHub state",
    );
    return refreshed;
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
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubFailureSource: "queue_eviction",
      ...(failureHeadSha ? { lastGitHubFailureHeadSha: failureHeadSha } : {}),
      ...(checkName ? { lastGitHubFailureCheckName: checkName } : {}),
      ...(failureSignature ? { lastGitHubFailureSignature: failureSignature } : {}),
    });
    const refreshed = this.db.issues.getIssue(issue.projectId, issue.linearIssueId);
    if (!refreshed) return issue;
    this.logger.info(
      { issueKey: issue.issueKey, prNumber: issue.prNumber },
      "Reclassified stale branch failure as queue repair from GitHub state",
    );
    return refreshed;
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
    const snapshot = await fetchPullRequestSnapshot(project.github.repoFullName, issue.prNumber);
    if (!snapshot.ok) {
      this.logger.debug(
        { issueKey: issue.issueKey, error: snapshot.error.message },
        "Failed to query GitHub PR state during reconciliation",
      );
      if (issue.prReviewState === "approved") {
        if (issue.factoryState !== "awaiting_queue" || hasFailureProvenance(issue)) {
          this.advanceIdleIssue(
            issue,
            "awaiting_queue",
            hasFailureProvenance(issue) ? { clearFailureProvenance: true } : {},
          );
        }
      }
      return;
    }
    const pr = snapshot.pr;
    {
      const previousHeadSha = issue.prHeadSha;
      const gateCheckNames = getGateCheckNames(project);
      const gateCheckStatus = deriveGateCheckStatusFromRollup(pr.statusCheckRollup, gateCheckNames);
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...buildPrStateUpdates(pr, gateCheckStatus, gateCheckNames[0] ?? "verify"),
      });
      if (pr.state === "MERGED") {
        this.db.issues.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
        const merged = this.db.issues.getIssue(issue.projectId, issue.linearIssueId) ?? { ...issue, prState: "merged" };
        await this.handleMergedIssue(merged);
        return;
      }
      if (pr.state === "CLOSED") {
        const closedPrDisposition = resolveClosedPrDisposition(issue);
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          prState: "closed",
          ...buildClosedPrCleanupFields(),
        });
        if (closedPrDisposition === "done") {
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber },
            "Reconciliation: PR was closed for an already completed issue; preserving done state",
          );
          this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
          return;
        }
        if (closedPrDisposition === "terminal") {
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

      const headAdvanced = Boolean(pr.headRefOid && pr.headRefOid !== previousHeadSha);
      if (issue.factoryState !== "awaiting_input") {
        const terminalRecoveryState = this.deriveTerminalRecoveryState(issue, pr.reviewDecision, gateCheckStatus, headAdvanced);
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
          this.advanceIdleIssue(issue, terminalRecoveryState, { clearFailureProvenance: true });
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
        prReviewState: refreshedIssue.prReviewState,
        prCheckStatus: refreshedIssue.prCheckStatus,
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
              issue.prNumber,
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
          clearFailureProvenance: true,
        });
        return;
      }
      if (
        issue.delegatedToPatchRelay
        && reactiveIntent?.runType === "review_fix"
        && this.db.workflowWakes.peekIssueWake(issue.projectId, issue.linearIssueId) === undefined
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
        this.advanceIdleIssue(issue, reactiveIntent.compatibilityFactoryState, {
          pendingRunType: reactiveIntent.runType,
          clearFailureProvenance: true,
        });
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
            issue.prNumber,
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
        this.db.issues.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          prReviewState: "approved",
        });
        if (issue.factoryState !== "awaiting_queue" || hasFailureProvenance(issue)) {
          const options = hasFailureProvenance(issue) ? { clearFailureProvenance: true } : undefined;
          this.advanceIdleIssue(issue, "awaiting_queue", options);
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

  private deriveTerminalRecoveryState(
    issue: Pick<IssueRecord, "factoryState">,
    reviewDecision: string | undefined,
    gateCheckStatus: string | undefined,
    headAdvanced: boolean,
  ): FactoryState | undefined {
    if (issue.factoryState !== "escalated" && issue.factoryState !== "failed") {
      return undefined;
    }
    if (isReviewDecisionApproved(reviewDecision) && !isFailingCheckStatus(gateCheckStatus)) {
      return "awaiting_queue";
    }
    if (gateCheckStatus === "pending") {
      return "pr_open";
    }
    if (headAdvanced && !isFailingCheckStatus(gateCheckStatus)) {
      return "pr_open";
    }
    if (isReviewDecisionReviewRequired(reviewDecision) && !isFailingCheckStatus(gateCheckStatus)) {
      return "pr_open";
    }
    return undefined;
  }
}
