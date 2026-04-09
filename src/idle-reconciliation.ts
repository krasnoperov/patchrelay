import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, BranchOwner } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { AppConfig } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import { deriveGateCheckStatusFromRollup, type GitHubStatusRollupEntry } from "./github-rollup.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import { parseStoredQueueRepairContext } from "./merge-queue-incident.ts";
import { execCommand } from "./utils.ts";

function isFailingCheckStatus(status: string | undefined): boolean {
  return status === "failed" || status === "failure";
}

function isReviewDecisionApproved(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "APPROVED";
}

function isReviewDecisionChangesRequested(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "CHANGES_REQUESTED";
}

function isReviewDecisionReviewRequired(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "REVIEW_REQUIRED";
}

function buildBranchUpkeepContext(prNumber: number, baseBranch: string, mergeStateStatus?: string, headSha?: string): Record<string, unknown> {
  const promptContext = [
    `The requested code change may already be present, but GitHub still reports PR #${prNumber} as ${mergeStateStatus ?? "DIRTY"} against latest ${baseBranch}.`,
    `This turn is branch upkeep on the existing PR branch: update onto latest ${baseBranch}, resolve any conflicts, rerun the narrowest relevant verification, and push a newer head.`,
    "Do not stop just because the requested code change is already present. Review can only move forward after a new pushed head.",
  ].join(" ");
  return {
    branchUpkeepRequired: true,
    reviewFixMode: "branch_upkeep",
    wakeReason: "branch_upkeep",
    promptContext,
    ...(mergeStateStatus ? { mergeStateStatus } : {}),
    ...(headSha ? { failingHeadSha: headSha } : {}),
    baseBranch,
  };
}

function hasCompletedReviewQuillVerdict(entries: GitHubStatusRollupEntry[] | undefined): boolean {
  return (entries ?? []).some((entry) => entry.__typename === "CheckRun"
    && entry.name === "review-quill/verdict"
    && entry.status === "COMPLETED");
}

function getGateCheckNames(project: AppConfig["projects"][number] | undefined): string[] {
  const configured = project?.gateChecks?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  return configured.length > 0 ? configured : ["verify"];
}

function isDuplicateRepairAttempt(
  issue: Pick<IssueRecord, "lastAttemptedFailureHeadSha" | "lastAttemptedFailureSignature">,
  context: Record<string, unknown> | undefined,
): boolean {
  const signature = typeof context?.failureSignature === "string" ? context.failureSignature : undefined;
  const headSha = typeof context?.failureHeadSha === "string"
    ? context.failureHeadSha
    : typeof context?.headSha === "string" ? context.headSha : undefined;
  if (!signature) return false;
  return issue.lastAttemptedFailureSignature === signature
    && (headSha === undefined || issue.lastAttemptedFailureHeadSha === headSha);
}

function buildFailureContext(issue: Pick<
  IssueRecord,
  | "lastGitHubFailureSource"
  | "lastGitHubFailureHeadSha"
  | "lastGitHubFailureSignature"
  | "lastGitHubFailureCheckName"
  | "lastGitHubFailureCheckUrl"
  | "lastGitHubFailureContextJson"
  | "lastQueueIncidentJson"
>): Record<string, unknown> | undefined {
  const storedFailureContext = parseGitHubFailureContext(issue.lastGitHubFailureContextJson);
  const queueRepairContext = issue.lastQueueIncidentJson
    ? parseStoredQueueRepairContext(issue.lastQueueIncidentJson)
    : undefined;
  if (!queueRepairContext
    && !issue.lastGitHubFailureSource
    && !issue.lastGitHubFailureHeadSha
    && !issue.lastGitHubFailureSignature
    && !issue.lastGitHubFailureCheckName
    && !issue.lastGitHubFailureCheckUrl
    && !storedFailureContext) {
    return undefined;
  }
  return {
    ...(issue.lastGitHubFailureSource ? { failureReason: issue.lastGitHubFailureSource } : {}),
    ...(issue.lastGitHubFailureHeadSha ? { failureHeadSha: issue.lastGitHubFailureHeadSha } : {}),
    ...(issue.lastGitHubFailureSignature ? { failureSignature: issue.lastGitHubFailureSignature } : {}),
    ...(issue.lastGitHubFailureCheckName ? { checkName: issue.lastGitHubFailureCheckName } : {}),
    ...(issue.lastGitHubFailureCheckUrl ? { checkUrl: issue.lastGitHubFailureCheckUrl } : {}),
    ...(storedFailureContext ? storedFailureContext : {}),
    ...(queueRepairContext ? queueRepairContext : {}),
  };
}

function hasFailureProvenance(issue: Pick<
  IssueRecord,
  | "lastGitHubFailureSource"
  | "lastGitHubFailureHeadSha"
  | "lastGitHubFailureSignature"
  | "lastGitHubFailureCheckName"
  | "lastGitHubFailureCheckUrl"
  | "lastGitHubFailureContextJson"
  | "lastGitHubFailureAt"
  | "lastQueueIncidentJson"
  | "lastAttemptedFailureHeadSha"
  | "lastAttemptedFailureSignature"
>): boolean {
  return Boolean(
    issue.lastGitHubFailureSource
      || issue.lastGitHubFailureHeadSha
      || issue.lastGitHubFailureSignature
      || issue.lastGitHubFailureCheckName
      || issue.lastGitHubFailureCheckUrl
      || issue.lastGitHubFailureContextJson
      || issue.lastGitHubFailureAt
      || issue.lastQueueIncidentJson
      || issue.lastAttemptedFailureHeadSha
      || issue.lastAttemptedFailureSignature,
  );
}

export function resolveBranchOwnerForStateTransition(newState: FactoryState, pendingRunType?: RunType): BranchOwner | undefined {
  if (pendingRunType) return "patchrelay";
  if (newState === "awaiting_queue") return "patchrelay";
  if (newState === "repairing_ci" || newState === "repairing_queue") return "patchrelay";
  return undefined;
}

export interface IdleReconciliationDeps {
  enqueueIssue(projectId: string, issueId: string): void;
}

export class IdleIssueReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly config: AppConfig,
    private readonly deps: IdleReconciliationDeps,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async reconcile(): Promise<void> {
    for (const issue of this.db.issues.listIdleNonTerminalIssues()) {
      if (issue.prState === "merged") {
        this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
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
      const unresolved = this.db.issues.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      if (unresolved === 0) {
        this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          eventType: "delegated",
          dedupeKey: `delegated:${issue.linearIssueId}`,
        });
        if (this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
          this.deps.enqueueIssue(issue.projectId, issue.linearIssueId);
        }
      }
    }
  }

  private shouldProbeTerminalIssueFromGitHub(issue: IssueRecord): boolean {
    if (issue.prNumber === undefined) return false;
    if (issue.activeRunId !== undefined) return false;
    if (issue.pendingRunType !== undefined) return false;
    return issue.factoryState === "escalated" || issue.factoryState === "failed";
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
          }
        : {}),
    });
    const branchOwner = resolveBranchOwnerForStateTransition(newState, options?.pendingRunType);
    if (branchOwner) {
      this.db.issues.setBranchOwner(issue.projectId, issue.linearIssueId, branchOwner);
    }
    if (options?.pendingRunType) {
      this.appendWakeEvent(issue, options.pendingRunType, options.pendingRunContext, "idle_reconciliation");
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
    if (options?.pendingRunType && this.db.issueSessions.peekIssueSessionWake(issue.projectId, issue.linearIssueId)) {
      this.deps.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  private appendWakeEvent(
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
    this.db.issueSessions.appendIssueSessionEventRespectingActiveLease(issue.projectId, issue.linearIssueId, {
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      eventType,
      ...(context ? { eventJson: JSON.stringify(context) } : {}),
      dedupeKey,
    });
  }

  private async routeFailedIssue(issue: IssueRecord): Promise<void> {
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
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "headRefOid,state,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup",
      ], { timeoutMs: 10_000 });
      const pr = JSON.parse(stdout) as {
        headRefOid?: string;
        state?: string;
        reviewDecision?: string;
        mergeable?: string;
        mergeStateStatus?: string;
        statusCheckRollup?: GitHubStatusRollupEntry[];
      };
      const previousHeadSha = issue.prHeadSha;
      const gateCheckNames = getGateCheckNames(project);
      const gateCheckStatus = deriveGateCheckStatusFromRollup(pr.statusCheckRollup, gateCheckNames);
      this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(pr.state === "OPEN" ? { prState: "open" as const } : {}),
        ...(isReviewDecisionApproved(pr.reviewDecision)
          ? { prReviewState: "approved" as const }
          : isReviewDecisionChangesRequested(pr.reviewDecision)
            ? { prReviewState: "changes_requested" as const }
            : isReviewDecisionReviewRequired(pr.reviewDecision)
              ? { prReviewState: "commented" as const }
            : {}),
        ...(gateCheckStatus ? { prCheckStatus: gateCheckStatus } : {}),
        ...(pr.headRefOid && gateCheckStatus
          ? {
              lastGitHubCiSnapshotHeadSha: pr.headRefOid,
              lastGitHubCiSnapshotGateCheckName: gateCheckNames[0] ?? "verify",
              lastGitHubCiSnapshotGateCheckStatus: gateCheckStatus,
              lastGitHubCiSnapshotSettledAt: gateCheckStatus === "pending" ? null : new Date().toISOString(),
            }
          : {}),
      });
      if (pr.state === "MERGED") {
        this.db.issues.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
        this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
        return;
      }
      if (pr.state === "CLOSED") {
        this.logger.info(
          { issueKey: issue.issueKey, prNumber: issue.prNumber },
          "Reconciliation: PR was closed, re-delegating for implementation",
        );
        this.db.issues.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "closed" });
        this.advanceIdleIssue(issue, "delegated" as never, {
          pendingRunType: "implementation",
          clearFailureProvenance: true,
        });
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

      if (isReviewDecisionReviewRequired(pr.reviewDecision)
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
      if ((issue.factoryState === "escalated" || issue.factoryState === "failed")
        && (reactiveIntent?.runType === "review_fix" || reactiveIntent?.runType === "branch_upkeep")) {
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
      if (reactiveIntent?.runType === "branch_upkeep" && mergeConflictDetected) {
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
      if (reactiveIntent?.runType === "queue_repair" && mergeConflictDetected) {
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
          this.advanceIdleIssue(issue, "awaiting_queue", {
            ...(hasFailureProvenance(issue) ? { clearFailureProvenance: true } : {}),
          });
        }
        return;
      }
      if (mergeConflictDetected) {
        this.logger.debug(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus },
          "Reconciliation: PR is dirty but no automation owner was derived",
        );
      }
    } catch (error) {
      this.logger.debug(
        { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
        "Failed to query GitHub PR state during reconciliation",
      );
      if (issue.prReviewState === "approved") {
        if (issue.factoryState !== "awaiting_queue" || hasFailureProvenance(issue)) {
          this.advanceIdleIssue(issue, "awaiting_queue", {
            ...(hasFailureProvenance(issue) ? { clearFailureProvenance: true } : {}),
          });
        }
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
