import type { InputRequestKind, WorkflowOutcome } from "./issue-phase.ts";
import type { IssuePhase } from "./issue-phase.ts";
import type { RunType } from "./run-type.ts";
import type { IssueClass, IssueClassSource } from "./issue-class.ts";
import type { IssueSessionState } from "./issue-session-state.ts";
import type { CompletionCheckOutcome } from "./completion-check-types.ts";

// Plan §4.4: `superseded` — the run was cancelled mid-flight because
// its premise no longer holds (e.g. the PR was approved on the same
// head while a `review_fix` run was still producing output). Combined
// with `shouldNotPublish` on the run row, this stops the next
// finalizer step from emitting a no-op republish.
export type RunStatus = "queued" | "running" | "completed" | "failed" | "released" | "superseded";
export type RunLaunchPhase = "claimed" | "worktree_prepared" | "thread_started" | "turn_started" | "running";
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
  issueClass?: IssueClass | undefined;
  issueClassSource?: IssueClassSource | undefined;
  issueTriageHash?: string | undefined;
  issueTriageResultJson?: string | undefined;
  parentLinearIssueId?: string | undefined;
  parentIssueKey?: string | undefined;
  issueKey?: string | undefined;
  title?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  priority?: number | undefined;
  estimate?: number | undefined;
  currentLinearState?: string | undefined;
  currentLinearStateType?: string | undefined;
  workflowOutcome?: WorkflowOutcome | undefined;
  workflowOutcomeReason?: string | undefined;
  inputRequestKind?: InputRequestKind | undefined;
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
  prIsDraft?: boolean | undefined;
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
  lastAttemptedFailureAt?: string | undefined;
  // Plan §4.1: change identity of the last patchrelay-attributed publish.
  // Populated by post-hoc detection so future runs can recognize a
  // patch-id-equivalent push and skip the cosmetic re-publish loop.
  // Currently observability-only — consumer wiring is a follow-up.
  lastPublishedPatchId?: string | undefined;
  lastPublishedIntegrationTreeId?: string | undefined;
  lastPublishedHeadSha?: string | undefined;
  // Plan §8.3: parent-of-child index for stacked PRs. Set when
  // patchrelay observes a PR with a base ref that is *not* the repo
  // default branch — that base ref names another PR's head branch.
  // Lookups by `parentPrBranch === <branch>` give us the inverse
  // index "given this PR's branch, who is stacked on me?" which is
  // what `pr_synchronize` needs to fan child-rebase workflow signals.
  parentPrBranch?: string | undefined;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  reviewFixAttempts: number;
  zombieRecoveryAttempts: number;
  lastZombieRecoveryAt?: string | undefined;
  /** Launches are deferred until this ISO timestamp after a Codex capacity
   * failure (usage limit / rate limit / quota). Cleared on the next
   * successful launch. */
  capacityBackoffUntil?: string | undefined;
  /** Consecutive Codex capacity failures, driving an escalating backoff
   * (2/5/10 min). Reset to 0 when a run completes successfully. */
  capacityBackoffAttempts: number;
  orchestrationSettleUntil?: string | undefined;
  /** When the issue entered the post-merge `deploying` state (ISO). Used
   * by the deploy watcher to scope which deploy runs are relevant and to
   * time out a deploy that never arrives. */
  deployStartedAt?: string | undefined;
  /** Optimistic-concurrency counter, bumped on every issue write. Writers
   * that derive an update from a read pass the read row's version to
   * `commitIssueState`; a mismatch means another writer landed in between. */
  version: number;
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
  lastWorkflowReason?: string | undefined;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  reviewFixAttempts: number;
  leaseId?: string | undefined;
  workerId?: string | undefined;
  leasedUntil?: string | undefined;
  createdAt: string;
  displayUpdatedAt: string;
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
  launchPhase?: RunLaunchPhase | undefined;
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
  failureReason?: string | undefined;
  lastCodexActivityAt?: string | undefined;
  lastCodexActivityKind?: string | undefined;
  lastCodexActivitySummary?: string | undefined;
  // Plan §4.4: hard publication-suppression flag. Even if the Codex
  // turn races ahead and produces output before its lease is
  // released, the run-finalizer reads this flag and refuses to
  // invoke `git push` / `gh pr create` / `gh pr edit`.
  shouldNotPublish?: boolean | undefined;
  authorityEpoch: number;
  leaseRevokedAt?: string | undefined;
  leaseRevokeReason?: string | undefined;
  // S5: the workflow task id this run was claimed for (e.g. "run:input"),
  // stamped at claim time so the finalizer closes the exact task.
  taskId?: string | undefined;
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

export interface IssueChildRecord {
  projectId: string;
  parentLinearIssueId: string;
  childLinearIssueId: string;
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
  issueClass?: IssueClass | undefined;
  issueKey?: string | undefined;
  title?: string | undefined;
  issueUrl?: string | undefined;
  statusNote?: string | undefined;
  currentLinearState?: string | undefined;
  sessionState?: IssueSessionState | undefined;
  phase: IssuePhase;
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

export type WorkflowObservationSource = "linear" | "github" | "git" | "runner" | "operator" | "executor";

export interface WorkflowObservationRecord {
  id: number;
  projectId: string;
  subjectId: string;
  source: WorkflowObservationSource;
  type: string;
  payloadJson?: string | undefined;
  dedupeKey?: string | undefined;
  observedAt: string;
}

export type WorkflowTaskStatus = "open" | "closed";

export interface WorkflowTaskRecord {
  id: number;
  projectId: string;
  subjectId: string;
  taskId: string;
  taskType: string;
  runType?: RunType | undefined;
  status: WorkflowTaskStatus;
  reason: string;
  requirementsJson?: string | undefined;
  authorityEpoch: number;
  gateAction: string;
  gateReason?: string | undefined;
  createdAt: string;
  updatedAt: string;
  closedAt?: string | undefined;
}
