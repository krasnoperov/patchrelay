import type { IssueRecord, RunRecord } from "./db-types.ts";
import { deriveIssueExecutionState } from "./issue-execution-state.ts";

export type { AwaitingInputReason } from "./issue-execution-state.ts";
import type { AwaitingInputReason } from "./issue-execution-state.ts";

export function resolveAwaitingInputReason(params: {
  issue: Pick<IssueRecord, "factoryState">;
  latestRun?: Pick<RunRecord, "completionCheckOutcome"> | undefined;
}): AwaitingInputReason | undefined {
  const state = deriveIssueExecutionState({
    factoryState: params.issue.factoryState,
    latestRunCompletionCheckOutcome: params.latestRun?.completionCheckOutcome,
  });
  return state.kind === "waiting_input" ? state.reason : undefined;
}
