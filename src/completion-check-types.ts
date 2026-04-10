export type CompletionCheckOutcome = "continue" | "needs_input" | "done" | "failed";

export interface CompletionCheckResult {
  outcome: CompletionCheckOutcome;
  summary: string;
  question?: string | undefined;
  why?: string | undefined;
  recommendedReply?: string | undefined;
}
