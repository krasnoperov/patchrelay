import type { SecretSource } from "./resolve-secret.ts";

export interface ReviewQuillRepositoryConfig {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
  waitForGreenChecks: boolean;
  requiredChecks: string[];
  excludeBranches: string[];
  reviewDocs: string[];
  diffIgnore: string[];
  diffSummarizeOnly: string[];
  patchBodyBudgetTokens: number;
}

export interface PromptFileFragment {
  sourcePath: string;
  content: string;
}

export interface PromptCustomizationLayer {
  extraInstructions?: PromptFileFragment;
  replaceSections: Record<string, PromptFileFragment>;
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
    heartbeatIntervalMs: number;
    staleQueuedAfterMs: number;
    staleRunningAfterMs: number;
  };
  codex: CodexAppServerConfig;
  prompting: PromptCustomizationLayer;
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
  mergedAt?: string;
  closedAt?: string;
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

export interface PullRequestReviewCommentRecord {
  id: number;
  reviewId?: number;
  body?: string;
  path?: string;
  line?: number;
  commitId?: string;
  authorLogin?: string;
  createdAt?: string;
}

export interface PriorReviewClaim {
  authorLogin?: string;
  state?: string;
  commitId?: string;
  excerpt: string;
}

export interface CheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  detailsUrl?: string;
  outputTitle?: string;
  outputSummary?: string;
  outputText?: string;
}

export interface GuidanceDoc {
  path: string;
  text: string;
}

export type DiffClassification = "full_patch" | "summarize" | "ignore";

export interface DiffFileInventoryEntry {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  isBinary: boolean;
  classification: DiffClassification;
  reason?: string;
}

export interface DiffFilePatchEntry extends DiffFileInventoryEntry {
  classification: "full_patch";
  patch: string;
}

export interface DiffSuppressedEntry extends DiffFileInventoryEntry {
  classification: "summarize" | "ignore";
  reason: string;
}

export interface ReviewWorkspace {
  repoFullName: string;
  cachePath: string;
  worktreePath: string;
  baseRef: string;
  diffBaseRef?: string;
  diffTarget?: "head" | "working-tree";
  headRef: string;
  headSha: string;
}

export interface ReviewDiffContext {
  inventory: DiffFileInventoryEntry[];
  patches: DiffFilePatchEntry[];
  suppressed: DiffSuppressedEntry[];
}

export interface PromptContext {
  guidanceDocs: GuidanceDoc[];
  priorReviewClaims: PriorReviewClaim[];
  issueKeys: string[];
}

export interface ReviewContext {
  workspaceMode: "checkout";
  workspace: ReviewWorkspace;
  repo: ReviewQuillRepositoryConfig;
  pr: PullRequestSummary;
  diff: ReviewDiffContext;
  promptCustomization: PromptCustomizationLayer;
  promptContext: PromptContext;
  prompt: string;
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
  stale?: boolean;
  staleReason?: string;
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
  checkRuns?: CheckRunRecord[];
}

export interface ReviewQuillPendingReview {
  repoId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  headRefName: string;
  reason: "checks_running" | "checks_failed" | "checks_unknown";
  failedChecks: string[];
  pendingChecks: string[];
  updatedAt: string;
}

export type ReviewFindingSeverity = "blocking" | "nit";

export interface ReviewFinding {
  path: string;
  line: number;
  severity: ReviewFindingSeverity;
  message: string;
  // 0-100. review-quill drops findings below a confidence threshold
  // before posting. If omitted by the model, treated as 100.
  confidence?: number;
  // Optional committable fix. Only honored when the entire issue can be
  // resolved by this one snippet and the snippet is ≤6 lines long.
  suggestion?: string;
}

export interface ReviewArchitecturalConcern {
  severity: ReviewFindingSeverity;
  // Free-form category label. Common values: "intent", "regression",
  // "convention", "product". Not enforced — any short label is fine.
  category: string;
  message: string;
}

export interface ReviewVerdict {
  // 2-4 paragraph wide narrative: what this PR does, author's intent,
  // how it fits into the codebase, notable risks. Goes into the review
  // body (top of the review).
  walkthrough: string;
  // Cross-file or product-level concerns that don't pin to one line.
  // Rendered into the review body after the walkthrough.
  architectural_concerns: ReviewArchitecturalConcern[];
  // Line-level findings. Each becomes one inline comment on the PR.
  findings: ReviewFinding[];
  // Final verdict. Review Quill is a binary gate in the merge pipeline:
  // approve when the PR is safe to merge, request changes otherwise.
  verdict: "approve" | "request_changes";
  // One-sentence rationale for the verdict. Appears at the bottom of
  // the review body so humans see why the bot decided what it decided.
  verdict_reason: string;
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
  pendingReviews: ReviewQuillPendingReview[];
}

export interface ReviewAttemptDetail {
  attempt: ReviewAttemptRecord;
  relatedAttempts: ReviewAttemptRecord[];
  currentPullRequest?: PullRequestSummary;
}
