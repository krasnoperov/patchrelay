import type { SecretSource } from "./resolve-secret.ts";

export interface ReviewQuillRepositoryConfig {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  requiredChecks: string[];
  excludeBranches: string[];
  reviewDocs: string[];
}

export interface CodexAppServerConfig {
  bin: string;
  args: string[];
  shellBin?: string;
  sourceBashrc?: boolean;
  requestTimeoutMs?: number;
  model?: string;
  modelProvider?: string;
  serviceName?: string;
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted";
  sandboxMode: "danger-full-access" | "workspace-write" | "read-only";
}

export interface ReviewQuillConfig {
  server: {
    bind: string;
    port: number;
    publicBaseUrl?: string;
  };
  database: {
    path: string;
    wal: boolean;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
  reconciliation: {
    pollIntervalMs: number;
  };
  codex: CodexAppServerConfig;
  repositories: ReviewQuillRepositoryConfig[];
  secretSources: Record<string, SecretSource>;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  body?: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED" | string;
  isDraft: boolean;
  headSha: string;
  headRefName: string;
  baseRefName: string;
  authorLogin?: string;
}

export interface PullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface PullRequestReviewRecord {
  id: number;
  state?: string;
  body?: string;
  authorLogin?: string;
  submittedAt?: string;
  commitId?: string;
}

export interface CheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  detailsUrl?: string;
}

export type ReviewAttemptStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export type ReviewAttemptConclusion = "approved" | "declined" | "skipped" | "error";

export interface ReviewAttemptRecord {
  id: number;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  status: ReviewAttemptStatus;
  conclusion?: ReviewAttemptConclusion;
  summary?: string;
  threadId?: string;
  turnId?: string;
  externalCheckRunId?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface WebhookEventRecord {
  deliveryId: string;
  eventType: string;
  repoFullName?: string;
  receivedAt: string;
  processedAt?: string;
  ignoredReason?: string;
}

export interface ReviewEligibility {
  eligible: boolean;
  reason?: string;
}

export interface ReviewVerdict {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: Array<{
    path?: string;
    line?: number;
    severity: "blocking" | "nit";
    message: string;
  }>;
}

export interface CodexThreadSummary {
  id: string;
  turns: CodexTurnSummary[];
}

export interface CodexTurnSummary {
  id: string;
  status: string;
  items: CodexThreadItem[];
}

export type CodexThreadItem =
  | { type: "agentMessage"; id: string; text: string }
  | { type: string; id: string; [key: string]: unknown };

export interface ReviewQuillRuntimeStatus {
  reconcileInProgress: boolean;
  lastReconcileStartedAt: string | null;
  lastReconcileCompletedAt: string | null;
  lastReconcileOutcome: "idle" | "running" | "succeeded" | "failed";
  lastReconcileError: string | null;
}

export interface ReviewQuillRepoSummary {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  totalAttempts: number;
  queuedAttempts: number;
  runningAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
  latestAttemptAt: string | null;
  latestConclusion: ReviewAttemptConclusion | null;
}

export interface ReviewQuillWatchSummary {
  totalRepos: number;
  totalAttempts: number;
  queuedAttempts: number;
  runningAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
}

export interface ReviewQuillWatchSnapshot {
  summary: ReviewQuillWatchSummary;
  runtime: ReviewQuillRuntimeStatus;
  repos: ReviewQuillRepoSummary[];
  attempts: ReviewAttemptRecord[];
  recentWebhooks: WebhookEventRecord[];
}

export interface ReviewAttemptDetail {
  attempt: ReviewAttemptRecord;
  relatedAttempts: ReviewAttemptRecord[];
}
