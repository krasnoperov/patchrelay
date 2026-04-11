import type { FactoryState, RunType } from "./factory-state.ts";
import type { IssueSessionState } from "./issue-session.ts";
import type { CompletionCheckOutcome } from "./completion-check-types.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "released";
export type GitHubFailureSource = "branch_ci" | "queue_eviction";

export interface GitHubCiSnapshotCheckRecord {
  name: string;
  status: "pending" | "success" | "failure";
  conclusion?: string | undefined;
  detailsUrl?: string | undefined;
  summary?: string | undefined;
}

export interface GitHubCiSnapshotRecord {
  headSha: string;
  gateCheckName?: string | undefined;
  gateCheckStatus: "pending" | "success" | "failure";
  failedChecks: GitHubCiSnapshotCheckRecord[];
  checks: GitHubCiSnapshotCheckRecord[];
  settledAt?: string | undefined;
  capturedAt: string;
}

export interface IssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  delegatedToPatchRelay: boolean;
  issueKey?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  priority?: number | undefined;
  estimate?: number | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  factoryState: FactoryState;
  pendingRunType?: RunType | undefined;
  pendingRunContextJson?: string | undefined;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  threadId?: string | undefined;
  activeRunId?: number | undefined;
  statusCommentId?: string | undefined;
  agentSessionId?: string | undefined;
  lastLinearActivityKey?: string | undefined;
  prNumber?: number | undefined;
  prUrl?: string | undefined;
  prState?: string | undefined;
  prHeadSha?: string | undefined;
  prAuthorLogin?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  lastBlockingReviewHeadSha?: string | undefined;
  lastGitHubFailureSource?: GitHubFailureSource | undefined;
  lastGitHubFailureHeadSha?: string | undefined;
  lastGitHubFailureSignature?: string | undefined;
  lastGitHubFailureCheckName?: string | undefined;
  lastGitHubFailureCheckUrl?: string | undefined;
  lastGitHubFailureContextJson?: string | undefined;
  lastGitHubFailureAt?: string | undefined;
  lastGitHubCiSnapshotHeadSha?: string | undefined;
  lastGitHubCiSnapshotGateCheckName?: string | undefined;
  lastGitHubCiSnapshotGateCheckStatus?: string | undefined;
  lastGitHubCiSnapshotJson?: string | undefined;
  lastGitHubCiSnapshotSettledAt?: string | undefined;
  lastQueueSignalAt?: string | undefined;
  lastQueueIncidentJson?: string | undefined;
  lastAttemptedFailureHeadSha?: string | undefined;
  lastAttemptedFailureSignature?: string | undefined;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  reviewFixAttempts: number;
  zombieRecoveryAttempts: number;
  lastZombieRecoveryAt?: string | undefined;
  updatedAt: string;
}

export interface IssueSessionRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  issueKey?: string | undefined;
  repoId: string;
  branchName?: string | undefined;
  worktreePath?: string | undefined;
  prNumber?: number | undefined;
  prHeadSha?: string | undefined;
  prAuthorLogin?: string | undefined;
  sessionState: IssueSessionState;
  waitingReason?: string | undefined;
  summaryText?: string | undefined;
  activeThreadId?: string | undefined;
  threadGeneration: number;
  activeRunId?: number | undefined;
  lastRunType?: RunType | undefined;
  lastWakeReason?: string | undefined;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  reviewFixAttempts: number;
  leaseId?: string | undefined;
  workerId?: string | undefined;
  leasedUntil?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export type { IssueSessionEventRecord, IssueSessionEventType } from "./issue-session-events.ts";

export interface RunRecord {
  id: number;
  issueId: number;
  projectId: string;
  linearIssueId: string;
  runType: RunType;
  status: RunStatus;
  sourceHeadSha?: string | undefined;
  promptText?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  parentThreadId?: string | undefined;
  completionCheckThreadId?: string | undefined;
  completionCheckTurnId?: string | undefined;
  completionCheckOutcome?: CompletionCheckOutcome | undefined;
  completionCheckSummary?: string | undefined;
  completionCheckQuestion?: string | undefined;
  completionCheckWhy?: string | undefined;
  completionCheckRecommendedReply?: string | undefined;
  completionCheckedAt?: string | undefined;
  summaryJson?: string | undefined;
  reportJson?: string | undefined;
  failureReason?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
}

export interface IssueDependencyRecord {
  projectId: string;
  linearIssueId: string;
  blockerLinearIssueId: string;
  blockerIssueKey?: string | undefined;
  blockerTitle?: string | undefined;
  blockerCurrentLinearState?: string | undefined;
  blockerCurrentLinearStateType?: string | undefined;
  updatedAt: string;
}

export interface WebhookEventRecord {
  id: number;
  webhookId: string;
  receivedAt: string;
}

// Re-export auth types
export type { LinearInstallationRecord, ProjectInstallationRecord, OAuthStateRecord } from "./linear-types.ts";

export interface TrackedIssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  delegatedToPatchRelay: boolean;
  issueKey?: string | undefined;
  title?: string | undefined;
  issueUrl?: string | undefined;
  statusNote?: string | undefined;
  currentLinearState?: string | undefined;
  sessionState?: IssueSessionState | undefined;
  factoryState: FactoryState;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  blockedByCount: number;
  blockedByKeys: string[];
  readyForExecution: boolean;
  latestFailureSource?: GitHubFailureSource | undefined;
  latestFailureHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
  latestFailureStepName?: string | undefined;
  latestFailureSummary?: string | undefined;
  waitingReason?: string | undefined;
  completionCheckActive?: boolean | undefined;
  activeRunId?: number | undefined;
  activeAgentSessionId?: string | undefined;
  updatedAt: string;
}

export interface ThreadEventRecord {
  id: number;
  runId: number;
  threadId: string;
  turnId?: string | undefined;
  method: string;
  eventJson: string;
  createdAt: string;
}
