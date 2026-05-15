import type { IssueDependencyRecord, IssueRecord, IssueSessionRecord } from "../../db-types.ts";

export interface ClusterHealthCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
  issueKey?: string | undefined;
  projectId?: string | undefined;
  prNumber?: number | undefined;
}

export interface ClusterHealthSummary {
  trackedIssues: number;
  openIssues: number;
  activeRuns: number;
  blockedIssues: number;
  readyIssues: number;
  ciTrackedPrs: number;
  ciPending: number;
  ciSuccess: number;
  ciFailure: number;
  ciUnknown: number;
  ciOrphaned: number;
  passCount: number;
  warnCount: number;
  failCount: number;
}

export type CiGateStatus = "pending" | "success" | "failure" | "unknown";

export type CiOwner =
  | "patchrelay"
  | "reviewer"
  | "review-quill"
  | "downstream"
  | "external"
  | "paused"
  | "unknown";

export interface ClusterCiEntry {
  issueKey?: string | undefined;
  projectId: string;
  prNumber: number;
  gateStatus: CiGateStatus;
  owner: CiOwner;
  orphaned: boolean;
  factoryState: string;
  reviewDecision?: string | undefined;
  message: string;
}

export interface ClusterHealthReport {
  generatedAt: string;
  ok: boolean;
  summary: ClusterHealthSummary;
  checks: ClusterHealthCheck[];
  ci: ClusterCiEntry[];
}

export interface ServiceProbeResult {
  status: "pass" | "warn" | "fail";
  message: string;
}

export interface IssueSnapshot {
  issue: IssueRecord;
  session?: IssueSessionRecord | undefined;
  blockedBy: IssueDependencyRecord[];
  missingTrackedBlockers: IssueDependencyRecord[];
  ageMs: number;
  readyForExecution: boolean;
}

export interface ReviewQuillAttemptOwnership {
  id?: number | undefined;
  status?: "queued" | "running" | undefined;
  headSha?: string | undefined;
  backlog?: boolean | undefined;
}
