import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, BranchOwner } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { AppConfig } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
import { parseStoredQueueRepairContext } from "./merge-queue-incident.ts";
import { execCommand } from "./utils.ts";

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

export function resolveBranchOwnerForStateTransition(newState: FactoryState, pendingRunType?: RunType): BranchOwner | undefined {
  if (pendingRunType) return "patchrelay";
  if (newState === "awaiting_queue") return "merge_steward";
  if (newState === "repairing_ci" || newState === "repairing_queue") return "patchrelay";
  return undefined;
}

export interface IdleReconciliationDeps {
  requestMergeQueueAdmission(issue: IssueRecord, projectId: string): Promise<void>;
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

      if (issue.prReviewState === "approved" && issue.prCheckStatus !== "failed") {
        if (issue.factoryState !== "awaiting_queue" || issue.branchOwner !== "merge_steward") {
          this.advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });
        } else if (!issue.queueLabelApplied) {
          await this.deps.requestMergeQueueAdmission(issue, issue.projectId);
        }
        continue;
      }

      if (issue.prCheckStatus === "failed") {
        await this.routeFailedIssue(issue);
        continue;
      }

      if (issue.factoryState === "pr_open" && !issue.prReviewState) {
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
    const resetQueueLabel = newState === "awaiting_queue" || issue.factoryState === "awaiting_queue";

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
      ...(resetQueueLabel ? { queueLabelApplied: false } : {}),
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
    if (newState === "awaiting_queue" && issue.factoryState !== "awaiting_queue") {
      void this.deps.requestMergeQueueAdmission(issue, issue.projectId);
    }
    if (options?.pendingRunType) {
      this.deps.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  private async routeFailedIssue(issue: IssueRecord): Promise<void> {
    if (issue.lastGitHubFailureSource === "queue_eviction") {
      const pendingRunContext = buildFailureContext(issue);
      if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
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
      if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
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
      const inferProject = this.config.projects.find((p) => p.id === issue.projectId);
      const inferProtocol = resolveMergeQueueProtocol(inferProject);
      let inferred: "queue_eviction" | "branch_ci" = "branch_ci";
      const probeSha = issue.lastGitHubFailureHeadSha ?? issue.lastGitHubCiSnapshotHeadSha;
      if (inferProject?.github?.repoFullName && issue.prNumber && probeSha) {
        try {
          const { stdout } = await execCommand("gh", [
            "api",
            `repos/${inferProject.github.repoFullName}/commits/${probeSha}/check-runs`,
            "--jq", `.check_runs[] | select(.name == "${inferProtocol.evictionCheckName}" and .conclusion == "failure") | .name`,
          ], { timeoutMs: 10_000 });
          if (stdout.trim().length > 0) inferred = "queue_eviction";
        } catch { /* best effort */ }
      }
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
    if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
      this.advanceIdleIssue(issue, "repairing_ci");
    } else {
      this.advanceIdleIssue(issue, "repairing_ci", {
        pendingRunType: "ci_repair",
        ...(pendingRunContext ? { pendingRunContext } : {}),
      });
    }
  }

  private async reconcileFromGitHub(issue: IssueRecord): Promise<void> {
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project?.github?.repoFullName || !issue.prNumber) return;
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "state,reviewDecision",
      ], { timeoutMs: 10_000 });
      const pr = JSON.parse(stdout) as { state?: string; reviewDecision?: string };
      if (pr.state === "MERGED") {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
        this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
      } else if (pr.reviewDecision === "APPROVED") {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prReviewState: "approved" });
        this.advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });
      }
    } catch (error) {
      this.logger.debug(
        { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
        "Failed to query GitHub PR state during reconciliation",
      );
    }
  }
}
