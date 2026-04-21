import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { ACTIVE_RUN_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import type { WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import type { AppConfig } from "./types.ts";
import { ImplementationOutcomePolicy } from "./implementation-outcome-policy.ts";
import { ReactiveRunPolicy } from "./reactive-run-policy.ts";

export interface PostRunFollowUp {
  pendingRunType: RunType;
  factoryState: FactoryState;
  context?: Record<string, unknown> | undefined;
  summary: string;
}

function resolvePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (ACTIVE_RUN_STATES.has(issue.factoryState) && issue.prNumber) {
    if (issue.prState === "merged") return "done";
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return undefined;
}

export function resolveCompletedRunState(
  issue: IssueRecord,
  _run: Pick<RunRecord, "runType">,
): FactoryState | undefined {
  return resolvePostRunState(issue);
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
