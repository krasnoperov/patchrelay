import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { ACTIVE_RUN_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { AppConfig } from "./types.ts";
import { ImplementationOutcomePolicy } from "./implementation-outcome-policy.ts";
import { ReactiveRunPolicy } from "./reactive-run-policy.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";

export interface PostRunFollowUp {
  pendingRunType: RunType;
  factoryState: FactoryState;
  context?: Record<string, unknown> | undefined;
  summary: string;
}

/** Which question the post-run resolver is answering (plan §B3). */
export type PostRunOutcome = "completed" | "recovered";

export type PostRunStateIssue = Pick<
  IssueRecord,
  "factoryState" | "prNumber" | "prState" | "prReviewState" | "prCheckStatus" | "lastGitHubFailureSource"
>;

// Plan §B3: the one post-run factory-state resolver. Unifies the former
// `resolveCompletedRunState` (run-completion-policy) and
// `resolveRecoverablePostRunState` (interrupted-run-recovery).
//
// Shared rule (both old functions agreed):
//   - no PR on the issue → undefined (nothing to resolve from PR truth);
//   - approved open/closed PR → awaiting_queue; otherwise pr_open;
//   - merged PR (while the issue is in an active-run state) → done.
//
// The two old functions genuinely disagreed in two places, and the
// disagreement is semantic, so it survives as the `outcome` option rather
// than being averaged away:
//   - outcome "completed" (the run did its work, default): gate every write
//     on ACTIVE_RUN_STATES so a state advanced concurrently by webhooks
//     (e.g. deploying, awaiting_queue) is never clobbered, and never
//     re-derive a reactive repair state — the stale GitHub verdict
//     (changes_requested / red CI) refers to the head the run just
//     replaced, and routing it again would loop the fix forever.
//   - outcome "recovered" (the run died without doing its work): GitHub
//     truth is authoritative regardless of the local factory state —
//     merged → done unconditionally, and an open PR re-derives the
//     reactive intent (repairing_ci / repairing_queue / changes_requested)
//     so the original problem is routed again.
export function resolvePostRunFactoryState(
  issue: PostRunStateIssue,
  _run: Pick<RunRecord, "runType">,
  options?: { outcome?: PostRunOutcome },
): FactoryState | undefined {
  if (!issue.prNumber) return undefined;

  if (options?.outcome === "recovered") {
    if (issue.prState === "merged") return "done";
    if (issue.prState === "open") {
      const reactiveIntent = deriveIssueSessionReactiveIntent({
        prNumber: issue.prNumber,
        prState: issue.prState,
        prReviewState: issue.prReviewState,
        prCheckStatus: issue.prCheckStatus,
        latestFailureSource: issue.lastGitHubFailureSource,
      });
      if (reactiveIntent) return reactiveIntent.compatibilityFactoryState;
      if (issue.prReviewState === "approved") return "awaiting_queue";
      return "pr_open";
    }
    // Closed (or unknown) PR: fall through to the factory-state-gated rule.
  }

  if (!ACTIVE_RUN_STATES.has(issue.factoryState)) return undefined;
  if (issue.prState === "merged") return "done";
  if (issue.prReviewState === "approved") return "awaiting_queue";
  return "pr_open";
}

export class RunCompletionPolicy {
  private readonly reactive: ReactiveRunPolicy;
  private readonly implementationOutcomes: ImplementationOutcomePolicy;

  constructor(
    config: AppConfig,
    db: PatchRelayDatabase,
    logger: Logger,
    withHeldLease: WithHeldIssueSessionLease,
  ) {
    this.reactive = new ReactiveRunPolicy(config, db, logger, withHeldLease);
    this.implementationOutcomes = new ImplementationOutcomePolicy(config, db, logger, withHeldLease);
  }

  async verifyReactiveRunAdvancedBranch(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    return await this.reactive.verifyReactiveRunAdvancedBranch(run, issue);
  }

  async verifyReviewFixAdvancedHead(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    return await this.reactive.verifyReviewFixAdvancedHead(run, issue);
  }

  async verifyReactiveRunStayedInScope(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    return await this.reactive.verifyReactiveRunStayedInScope(run, issue);
  }

  async refreshIssueAfterReactivePublish(run: RunRecord, issue: IssueRecord): Promise<IssueRecord> {
    return await this.reactive.refreshIssueAfterReactivePublish(run, issue);
  }

  async resolveRequestedChangesWakeContext(
    issue: IssueRecord,
    runType: RunType,
    context: Record<string, unknown> | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    return await this.reactive.resolveRequestedChangesWakeContext(issue, runType, context);
  }

  async resolvePostRunFollowUp(
    run: Pick<RunRecord, "runType" | "projectId">,
    issue: IssueRecord,
  ): Promise<PostRunFollowUp | undefined> {
    return await this.reactive.resolvePostRunFollowUp(run, issue);
  }

  async verifyPublishedRunOutcome(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    return await this.implementationOutcomes.verifyPublishedRunOutcome(run, issue);
  }

  async detectRecoverableFailedImplementationOutcome(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    return await this.implementationOutcomes.detectRecoverableFailedImplementationOutcome(run, issue);
  }
}
