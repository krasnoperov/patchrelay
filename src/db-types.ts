import type { FactoryState, RunType } from "./factory-state.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "released";
export type GitHubFailureSource = "branch_ci" | "queue_eviction";

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
  lastGitHubFailureCheckName?: string | undefined;
  lastGitHubFailureCheckUrl?: string | undefined;
  lastGitHubFailureAt?: string | undefined;
  lastQueueSignalAt?: string | undefined;
  lastQueueIncidentJson?: string | undefined;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  reviewFixAttempts: number;
  zombieRecoveryAttempts: number;
  lastZombieRecoveryAt?: string | undefined;
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
