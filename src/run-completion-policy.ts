import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunType } from "./run-type.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { AppConfig } from "./types.ts";
import { ImplementationOutcomePolicy } from "./implementation-outcome-policy.ts";
import { ReactiveRunPolicy } from "./reactive-run-policy.ts";
import { deriveReactiveWorkflowIntent } from "./reactive-workflow-intent.ts";
import type { RunContext } from "./run-context.ts";
import type { WorkflowRunIntent } from "./workflow-intent.ts";

export interface PostRunFollowUp {
  workflowIntent: WorkflowRunIntent;
  summary: string;
}

/** Which question the post-run resolver is answering (plan §B3). */
export type PostRunOutcome = "completed" | "recovered";

export type PostRunStateIssue = Pick<
  IssueRecord,
  "activeRunId"
    | "prNumber"
    | "prState"
    | "prHeadSha"
    | "prReviewState"
    | "prCheckStatus"
    | "lastBlockingReviewHeadSha"
    | "lastGitHubFailureSource"
>;

export interface PostRunFactUpdate {
  workflowOutcome?: "completed" | null;
  workflowOutcomeReason?: string | null;
  inputRequestKind?: null;
}

// Plan §B3: the one post-run fact resolver. Unifies the former
// `resolveCompletedRunState` (run-completion-policy) and
// `resolveRecoverablePostRunState` (interrupted-run-recovery).
//
// Shared rule (both old functions agreed):
//   - no PR on the issue → undefined (nothing to resolve from PR truth);
//   - approved open/closed PR → awaiting_queue; otherwise pr_open;
//   - merged PR (while the issue still points at this run) → done.
//
// The two old functions genuinely disagreed in two places, and the
// disagreement is semantic, so it survives as the `outcome` option rather
// than being averaged away:
//   - outcome "completed" (the run did its work, default): gate every write
//     on the issue still pointing at this exact active run so a state advanced
//     concurrently by webhooks/finalizers is never clobbered, and never
//     re-derive a reactive repair state — the stale GitHub verdict
//     (changes_requested / red CI) refers to the head the run just
//     replaced, and routing it again would loop the fix forever.
//   - outcome "recovered" (the run died without doing its work): GitHub
//     truth is authoritative regardless of the derived display phase —
//     merged → done unconditionally, and an open PR re-derives the
//     reactive intent (repairing_ci / repairing_queue / changes_requested)
//     so the original problem is routed again.
export function resolvePostRunFactUpdate(
  issue: PostRunStateIssue,
  run: Pick<RunRecord, "id" | "runType">,
  options?: { outcome?: PostRunOutcome },
): PostRunFactUpdate | undefined {
  if (!issue.prNumber) return undefined;

  if (options?.outcome === "recovered") {
    if (issue.prState === "merged") {
      return { workflowOutcome: "completed", workflowOutcomeReason: "pr_merged", inputRequestKind: null };
    }
    if (issue.prState === "open") {
      const reactiveIntent = deriveReactiveWorkflowIntent({
        prNumber: issue.prNumber,
        prState: issue.prState,
        prHeadSha: issue.prHeadSha,
        prReviewState: issue.prReviewState,
        prCheckStatus: issue.prCheckStatus,
        lastBlockingReviewHeadSha: issue.lastBlockingReviewHeadSha,
        latestFailureSource: issue.lastGitHubFailureSource,
      });
      if (reactiveIntent) return { workflowOutcome: null, workflowOutcomeReason: null, inputRequestKind: null };
      return { workflowOutcome: null, workflowOutcomeReason: null, inputRequestKind: null };
    }
    // Closed (or unknown) PR: fall through to the active-run guard.
  }

  if (issue.activeRunId !== run.id) return undefined;
  if (issue.prState === "merged") {
    return { workflowOutcome: "completed", workflowOutcomeReason: "pr_merged", inputRequestKind: null };
  }
  return { workflowOutcome: null, workflowOutcomeReason: null, inputRequestKind: null };
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

  async resolveRequestedChangesWorkflowContext(
    issue: IssueRecord,
    runType: RunType,
    context: RunContext | undefined,
  ): Promise<RunContext | undefined> {
    return await this.reactive.resolveRequestedChangesWorkflowContext(issue, runType, context);
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
