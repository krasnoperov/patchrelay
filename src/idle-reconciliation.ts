import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, BranchOwner } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { AppConfig } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import { deriveGateCheckStatusFromRollup, type GitHubStatusRollupEntry } from "./github-rollup.ts";
import { parseStoredQueueRepairContext } from "./merge-queue-incident.ts";
import { execCommand } from "./utils.ts";

function isFailingCheckStatus(status: string | undefined): boolean {
  return status === "failed" || status === "failure";
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
    for (const issue of this.db.listIdleNonTerminalIssues()) {
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

    for (const issue of this.db.listBlockedDelegatedIssues()) {
      const unresolved = this.db.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      if (unresolved === 0) {
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          pendingRunType: "implementation",
        });
        this.deps.enqueueIssue(issue.projectId, issue.linearIssueId);
      }
    }
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
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: newState,
      ...(options?.pendingRunType ? { pendingRunType: options.pendingRunType } : {}),
      ...(options?.pendingRunType
        ? {
            pendingRunContextJson: options.pendingRunContext ? JSON.stringify(options.pendingRunContext) : null,
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
      this.db.setBranchOwner(issue.projectId, issue.linearIssueId, branchOwner);
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
    if (options?.pendingRunType) {
      this.deps.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  private async routeFailedIssue(issue: IssueRecord): Promise<void> {
    issue = await this.refreshMissingFailureProvenance(issue);
    issue = await this.reclassifyStaleBranchFailure(issue);
    const latestRun = this.db.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
    const ignoreDuplicateAttempt = latestRun?.status === "failed"
      && latestRun.failureReason === "Codex turn was interrupted";

    if (issue.lastGitHubFailureSource === "queue_eviction") {
      const pendingRunContext = buildFailureContext(issue);
      if (!ignoreDuplicateAttempt && isDuplicateRepairAttempt(issue, pendingRunContext)) {
        this.advanceIdleIssue(issue, "repairing_queue");
      } else {
        this.advanceIdleIssue(issue, "repairing_queue", {
          pendingRunType: "queue_repair",
          ...(pendingRunContext ? { pendingRunContext } : {}),
        });
      }
      return;
    }

    if (issue.lastGitHubFailureSource === "branch_ci") {
      const pendingRunContext = buildFailureContext(issue);
      if (!ignoreDuplicateAttempt && isDuplicateRepairAttempt(issue, pendingRunContext)) {
        this.advanceIdleIssue(issue, "repairing_ci");
      } else {
        this.advanceIdleIssue(issue, "repairing_ci", {
          pendingRunType: "ci_repair",
          ...(pendingRunContext ? { pendingRunContext } : {}),
        });
      }
      return;
    }

    if (issue.factoryState === "awaiting_queue") {
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

    const pendingRunContext = buildFailureContext(issue);
    if (!ignoreDuplicateAttempt && isDuplicateRepairAttempt(issue, pendingRunContext)) {
      this.advanceIdleIssue(issue, "repairing_ci");
    } else {
      this.advanceIdleIssue(issue, "repairing_ci", {
        pendingRunType: "ci_repair",
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
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubFailureSource: inferred,
      ...(failureHeadSha ? { lastGitHubFailureHeadSha: failureHeadSha } : {}),
      ...(checkName ? { lastGitHubFailureCheckName: checkName } : {}),
      ...(failureSignature ? { lastGitHubFailureSignature: failureSignature } : {}),
    });
    const refreshed = this.db.getIssue(issue.projectId, issue.linearIssueId);
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
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lastGitHubFailureSource: "queue_eviction",
      ...(failureHeadSha ? { lastGitHubFailureHeadSha: failureHeadSha } : {}),
      ...(checkName ? { lastGitHubFailureCheckName: checkName } : {}),
      ...(failureSignature ? { lastGitHubFailureSignature: failureSignature } : {}),
    });
    const refreshed = this.db.getIssue(issue.projectId, issue.linearIssueId);
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
      const gateCheckNames = getGateCheckNames(project);
      const gateCheckStatus = deriveGateCheckStatusFromRollup(pr.statusCheckRollup, gateCheckNames);
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(pr.state === "OPEN" ? { prState: "open" as const } : {}),
        ...(pr.reviewDecision === "APPROVED"
          ? { prReviewState: "approved" as const }
          : pr.reviewDecision === "CHANGES_REQUESTED"
            ? { prReviewState: "changes_requested" as const }
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
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
        this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
        return;
      }
      if (pr.state === "CLOSED") {
        this.logger.info(
          { issueKey: issue.issueKey, prNumber: issue.prNumber },
          "Reconciliation: PR was closed, re-delegating for implementation",
        );
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "closed" });
        this.advanceIdleIssue(issue, "delegated" as never, {
          pendingRunType: "implementation",
          clearFailureProvenance: true,
        });
        return;
      }
      if (pr.reviewDecision === "APPROVED") {
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          prReviewState: "approved",
        });
        if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable },
            "Reconciliation: approved PR has merge conflicts, dispatching rebase",
          );
          this.advanceIdleIssue(issue, "repairing_queue" as never, {
            pendingRunType: "queue_repair",
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
            stage: "repairing_queue",
            status: "conflict_detected",
            summary: `Approved PR #${issue.prNumber} has merge conflicts with main, dispatching rebase`,
          });
          return;
        }
        if (issue.factoryState !== "awaiting_queue" || hasFailureProvenance(issue)) {
          this.advanceIdleIssue(issue, "awaiting_queue", {
            ...(hasFailureProvenance(issue) ? { clearFailureProvenance: true } : {}),
          });
        }
        return;
      }
      if ((pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") && issue.factoryState === "awaiting_queue") {
        this.logger.info(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable },
          "Reconciliation: queue-admitted PR has merge conflicts, dispatching rebase",
        );
        this.advanceIdleIssue(issue, "repairing_queue" as never, {
          pendingRunType: "queue_repair",
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
          stage: "repairing_queue",
          status: "conflict_detected",
          summary: `PR #${issue.prNumber} has merge conflicts with main, dispatching rebase`,
        });
      } else if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
        this.logger.debug(
          { issueKey: issue.issueKey, prNumber: issue.prNumber, mergeable: pr.mergeable, mergeStateStatus: pr.mergeStateStatus },
          "Reconciliation: PR is dirty but not yet queue-admitted; leaving PatchRelay in review state",
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
}
