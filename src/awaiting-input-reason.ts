import type { IssueRecord, RunRecord } from "./db-types.ts";

export type AwaitingInputReason = "paused_local_work" | "completion_check_question";

export function resolveAwaitingInputReason(params: {
  issue: Pick<IssueRecord, "factoryState">;
  latestRun?: Pick<RunRecord, "completionCheckOutcome"> | undefined;
}): AwaitingInputReason | undefined {
  if (params.issue.factoryState !== "awaiting_input") {
    return undefined;
  }
  if (params.latestRun?.completionCheckOutcome === "needs_input") {
    return "completion_check_question";
  }
  return "paused_local_work";
}
