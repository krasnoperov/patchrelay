import type { FactoryState, RunType } from "./factory-state.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "released";
export type GitHubFailureSource = "branch_ci" | "queue_eviction";
export type BranchOwner = "patchrelay" | "merge_steward";

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
  branchOwner?: BranchOwner | undefined;
  branchOwnershipChangedAt?: string | undefined;
  worktreePath?: string | undefined;
  threadId?: string | undefined;
  activeRunId?: number | undefined;
  agentSessionId?: string | undefined;
  prNumber?: number | undefined;
  prUrl?: string | undefined;
  prState?: string | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
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
  queueLabelApplied: boolean;
  updatedAt: string;
}

export interface RunRecord {
  id: number;
  issueId: number;
  projectId: string;
  linearIssueId: string;
  runType: RunType;
  status: RunStatus;
  promptText?: string | undefined;
  threadId?: string | undefined;
  turnId?: string | undefined;
  parentThreadId?: string | undefined;
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
  issueKey?: string | undefined;
  title?: string | undefined;
  issueUrl?: string | undefined;
  currentLinearState?: string | undefined;
  factoryState: FactoryState;
  blockedByCount: number;
  blockedByKeys: string[];
  readyForExecution: boolean;
  latestFailureSource?: GitHubFailureSource | undefined;
  latestFailureHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
  latestFailureStepName?: string | undefined;
  latestFailureSummary?: string | undefined;
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
