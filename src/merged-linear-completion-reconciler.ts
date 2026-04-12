import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";
import { resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import { isCompletedLinearState } from "./pr-state.ts";
import { hasTrustedNoPrCompletion } from "./trusted-no-pr-completion.ts";
import type { LinearClientProvider } from "./types.ts";

const COMPLETION_RECONCILE_WINDOW_MS = 60 * 60 * 1000;
const COMPLETION_RECONCILE_SUCCESS_BACKOFF_MS = 60 * 60 * 1000;
const COMPLETION_RECONCILE_FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const COMPLETION_RECONCILE_RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;
const COMPLETION_RECONCILE_MAX_ISSUES_PER_PASS = 10;

interface CompletionRetryEntry {
  retryAfter: number;
  updatedAt: string;
}

export class MergedLinearCompletionReconciler {
  private readonly retryAfterByIssueKey = new Map<string, CompletionRetryEntry>();
  private globalRetryAfter: number | undefined;

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {}

  async reconcile(): Promise<void> {
    const now = Date.now();
    if (this.globalRetryAfter !== undefined) {
      if (this.globalRetryAfter > now) {
        return;
      }
      this.globalRetryAfter = undefined;
    }

    const candidates = this.db.issues.listIssues()
      .filter((issue) => this.isRecentCompletionCandidate(issue, now))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    this.pruneRetryBackoff(candidates, now);

    let attemptedIssues = 0;
    for (const issue of candidates) {
      if (attemptedIssues >= COMPLETION_RECONCILE_MAX_ISSUES_PER_PASS) {
        break;
      }
      if (!this.shouldAttemptIssue(issue, now)) {
        continue;
      }

      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) {
        continue;
      }
      attemptedIssues += 1;

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

        const latestRun = this.db.runs.getLatestRunForIssue(issue.projectId, issue.linearIssueId);
        const trustedNoPrDone = hasTrustedNoPrCompletion(issue, latestRun);

        if (issue.prState === "merged" || trustedNoPrDone) {
          await this.reconcileCompletedLinearState(issue, liveIssue, linear);
          this.settleIssue(issue, now);
          continue;
        }

        if (issue.factoryState === "done" && !isCompletedLinearState(liveIssue.stateType, liveIssue.stateName)) {
          this.reopenStaleLocalDoneIssue(issue, liveIssue);
        } else {
          this.refreshCachedLinearState(issue, liveIssue);
        }
        this.settleIssue(issue, now);
      } catch (error) {
        this.deferIssue(issue, error, now);
        this.logger.warn(
          { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
          "Failed to reconcile merged or stale completed issue state",
        );
        if (isRateLimitedError(error)) {
          this.globalRetryAfter = now + COMPLETION_RECONCILE_RATE_LIMIT_BACKOFF_MS;
          break;
        }
      }
    }
  }

  private async reconcileCompletedLinearState(
    issue: IssueRecord,
    liveIssue: Awaited<ReturnType<NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>["getIssue"]>>,
    linear: NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>,
  ): Promise<void> {
    if (isCompletedLinearState(liveIssue.stateType, liveIssue.stateName)) {
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
    issue: Pick<IssueRecord, "projectId" | "linearIssueId" | "currentLinearState" | "currentLinearStateType">,
    liveIssue: Awaited<ReturnType<NonNullable<Awaited<ReturnType<LinearClientProvider["forProject"]>>>["getIssue"]>>,
  ): void {
    if (issue.currentLinearState === liveIssue.stateName && issue.currentLinearStateType === liveIssue.stateType) {
      return;
    }
    this.db.issues.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
      ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
    });
  }

  private isRecentCompletionCandidate(issue: IssueRecord, now: number): boolean {
    if (issue.factoryState !== "done" && issue.prState !== "merged") {
      return false;
    }
    const updatedAt = Date.parse(issue.updatedAt);
    return Number.isFinite(updatedAt) && now - updatedAt <= COMPLETION_RECONCILE_WINDOW_MS;
  }

  private shouldAttemptIssue(issue: IssueRecord, now: number): boolean {
    const retry = this.retryAfterByIssueKey.get(this.issueKey(issue));
    if (!retry) {
      return true;
    }
    if (retry.updatedAt !== issue.updatedAt) {
      this.retryAfterByIssueKey.delete(this.issueKey(issue));
      return true;
    }
    return retry.retryAfter <= now;
  }

  private settleIssue(issue: IssueRecord, now: number): void {
    this.retryAfterByIssueKey.set(this.issueKey(issue), {
      retryAfter: now + COMPLETION_RECONCILE_SUCCESS_BACKOFF_MS,
      updatedAt: issue.updatedAt,
    });
  }

  private deferIssue(issue: IssueRecord, error: unknown, now: number): void {
    const message = error instanceof Error ? error.message : String(error);
    const backoffMs = /ratelimit|rate limit/i.test(message)
      ? COMPLETION_RECONCILE_RATE_LIMIT_BACKOFF_MS
      : COMPLETION_RECONCILE_FAILURE_BACKOFF_MS;
    this.retryAfterByIssueKey.set(this.issueKey(issue), {
      retryAfter: now + backoffMs,
      updatedAt: issue.updatedAt,
    });
  }

  private pruneRetryBackoff(candidates: IssueRecord[], now: number): void {
    const candidateKeys = new Set(candidates.map((issue) => this.issueKey(issue)));
    for (const [key, retry] of this.retryAfterByIssueKey.entries()) {
      if (!candidateKeys.has(key) || retry.retryAfter <= now) {
        this.retryAfterByIssueKey.delete(key);
      }
    }
  }

  private issueKey(issue: Pick<IssueRecord, "projectId" | "linearIssueId">): string {
    return `${issue.projectId}::${issue.linearIssueId}`;
  }
}

function isRateLimitedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ratelimit|rate limit/i.test(message);
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
