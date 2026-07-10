import type { GitHubFailureSource, IssueRecord, WorkflowObservationRecord } from "./db-types.ts";
import type { RunType } from "./run-type.ts";
import type { RunContext } from "./run-context.ts";

// Append-only signal observations that reconciled facts cannot "un-happen".
// Consumption is itself an observation (`workflow.signal_consumed`), never a
// column, so task derivation stays a pure function of the log:
//   unconsumed = signals - consumed observation ids
export const HUMAN_INPUT_OBSERVATION = "human.input";
export const COMPLETION_CHECK_CONTINUE_OBSERVATION = "executor.completion_check_continue";
export const CHILD_OBSERVATION_TYPES = new Set<string>([
  "orchestration.child_changed",
  "orchestration.child_delivered",
  "orchestration.child_regressed",
]);
export const SIGNAL_CONSUMED_OBSERVATION = "workflow.signal_consumed";

export type WorkflowTaskType = "run" | "verify" | "ask" | "wait" | "publish" | "escalate";

export interface WorkflowAuthority {
  delegated: boolean;
  epoch: number;
  source: "linear" | "operator";
  observedAt?: string | undefined;
}

export interface WorkflowArtifact {
  type: "branch" | "commit" | "pr" | "review" | "check" | "linear_session" | "codex_thread";
  ref: string;
  state?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface WorkflowRunSnapshot {
  id: number;
  runType: RunType;
  authorityEpoch: number;
  status: string;
}

export interface WorkflowTask {
  id: string;
  type: WorkflowTaskType;
  reason: string;
  runType?: RunType | undefined;
  requirements?: Record<string, unknown> | undefined;
}

export interface WorkflowContext {
  issueKey?: string | undefined;
  title?: string | undefined;
  displayState: IssueRecord["factoryState"];
  awaitingInput: boolean;
  lastBlockingReviewHeadSha?: string | undefined;
  lastGitHubFailureSource?: GitHubFailureSource | undefined;
  lastGitHubFailureHeadSha?: string | undefined;
  lastGitHubFailureSignature?: string | undefined;
  lastAttemptedFailureHeadSha?: string | undefined;
  lastAttemptedFailureSignature?: string | undefined;
  failureContext?: RunContext | undefined;
  ciSnapshot?: RunContext["ciSnapshot"] | undefined;
  requestedChangesContext?: RunContext | undefined;
  delegationContext?: RunContext | undefined;
  branchUpkeepContext?: BranchUpkeepContext | undefined;
  inputInboxContext?: InboxInputContext | undefined;
  orchestrationInboxContext?: OrchestrationInboxContext | undefined;
}

export interface InboxInputContext {
  runType: RunType;
  workflowReason: string;
  consumesObservationIds: number[];
  requirements: Record<string, unknown>;
}

export interface OrchestrationInboxContext {
  consumesObservationIds: number[];
  requirements: Record<string, unknown>;
}

export interface BranchUpkeepContext {
  parentBranch?: string | undefined;
  parentHeadSha?: string | undefined;
  childPrNumber?: number | undefined;
}

export interface WorkflowSnapshot {
  id: string;
  projectId: string;
  subjectId: string;
  status: "idle" | "waiting" | "running" | "done" | "failed";
  authority: WorkflowAuthority;
  context: WorkflowContext;
  openTasks: WorkflowTask[];
  activeRun?: WorkflowRunSnapshot | undefined;
  artifacts: WorkflowArtifact[];
  blockerCount: number;
  childCount: number;
  openChildCount: number;
}

export type GateDecision =
  | { action: "start" }
  | { action: "wait"; reason: string }
  | { action: "ask"; reason: string; question: string }
  | { action: "escalate"; reason: string };

export interface WorkflowProjectionInput {
  issue: IssueRecord;
  observations?: WorkflowObservationRecord[] | undefined;
  blockerCount?: number | undefined;
  childCount?: number | undefined;
  openChildCount?: number | undefined;
  activeRun?: WorkflowRunSnapshot | undefined;
}
