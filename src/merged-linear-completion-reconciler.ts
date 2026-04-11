import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import { isCompletedLinearState } from "./pr-state.ts";
import type { LinearClientProvider } from "./types.ts";

export class MergedLinearCompletionReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {}

  async reconcile(): Promise<void> {
    for (const issue of this.db.issues.listIssues()) {
      if (issue.factoryState !== "done" && issue.prState !== "merged") {
        continue;
      }

      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) {
        continue;
      }

      try {
        const liveIssue = await linear.getIssue(issue.linearIssueId);
        this.db.issues.replaceIssueDependencies({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          blockers: liveIssue.blockedBy.map((blocker) => ({
            blockerLinearIssueId: blocker.id,
            ...(blocker.identifier ? { blockerIssueKey: blocker.identifier } : {}),
            ...(blocker.title ? { blockerTitle: blocker.title } : {}),
            ...(blocker.stateName ? { blockerCurrentLinearState: blocker.stateName } : {}),
            ...(blocker.stateType ? { blockerCurrentLinearStateType: blocker.stateType } : {}),
          })),
        });

        if (issue.prState === "merged") {
          await this.reconcileMergedLinearState(issue, liveIssue, linear);
          continue;
        }

        if (issue.factoryState === "done" && !isCompletedLinearState(liveIssue.stateType, liveIssue.stateName)) {
          this.reopenStaleLocalDoneIssue(issue, liveIssue);
        } else {
          this.refreshCachedLinearState(issue, liveIssue);
        }
      } catch (error) {
        this.logger.warn(
          { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
          "Failed to reconcile merged or stale completed issue state",
        );
      }
    }
  }

  private async reconcileMergedLinearState(
    issue: IssueRecord,
    liveIssue: Awaited<ReturnType<NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>["getIssue"]>>,
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
  ): Promise<void> {
    if (issue.currentLinearStateType?.trim().toLowerCase() === "completed") {
      this.refreshCachedLinearState(issue, liveIssue);
      return;
    }

    const targetState = resolvePreferredCompletedLinearState(liveIssue);
    if (!targetState) {
      this.refreshCachedLinearState(issue, liveIssue);
      return;
    }

    const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
    if (normalizedCurrent === targetState.trim().toLowerCase()) {
      this.refreshCachedLinearState(issue, liveIssue);
      return;
    }

    const updated = await linear.setIssueState(issue.linearIssueId, targetState);
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
      ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
    });
  }

  private reopenStaleLocalDoneIssue(
    issue: IssueRecord,
    liveIssue: Awaited<ReturnType<NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>["getIssue"]>>,
  ): void {
    const restored = resolveOpenWorkflowState(issue);
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
      ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
      ...(restored ? { factoryState: restored.factoryState } : {}),
      ...(restored ? { pendingRunType: restored.pendingRunType } : {}),
    });
    this.logger.info(
      {
        issueKey: issue.issueKey,
        previousFactoryState: issue.factoryState,
        restoredFactoryState: restored?.factoryState,
        liveLinearState: liveIssue.stateName,
      },
      "Reopened stale local done state from live Linear workflow",
    );
  }

  private refreshCachedLinearState(
    issue: Pick<IssueRecord, "projectId" | "linearIssueId">,
    liveIssue: Awaited<ReturnType<NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>["getIssue"]>>,
  ): void {
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
      ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
    });
  }
}

function resolveOpenWorkflowState(
  issue: Pick<IssueRecord, "delegatedToPatchRelay" | "prNumber" | "prState" | "prReviewState" | "prCheckStatus" | "lastGitHubFailureSource">,
): { factoryState: FactoryState; pendingRunType: RunType | null } | undefined {
  const reactiveIntent = deriveIssueSessionReactiveIntent({
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    prNumber: issue.prNumber,
    prState: issue.prState,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    latestFailureSource: issue.lastGitHubFailureSource,
  });
  if (reactiveIntent) {
    return {
      factoryState: reactiveIntent.compatibilityFactoryState,
      pendingRunType: reactiveIntent.runType,
    };
  }

  if (issue.prNumber !== undefined && (issue.prState === undefined || issue.prState === "open")) {
    if (issue.prReviewState === "approved" && (issue.prCheckStatus === "success" || issue.prCheckStatus === "passed")) {
      return { factoryState: "awaiting_queue", pendingRunType: null };
    }
    return { factoryState: "pr_open", pendingRunType: null };
  }

  if (issue.delegatedToPatchRelay) {
    return { factoryState: "delegated", pendingRunType: null };
  }

  return undefined;
}
