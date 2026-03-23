import type { FactoryState, RunType } from "./factory-state.ts";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "released";

export interface IssueRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  issueKey?: string | undefined;
  title?: string | undefined;
  url?: string | undefined;
  currentLinearState?: string | undefined;
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
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  pendingMergePrep: boolean;
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
