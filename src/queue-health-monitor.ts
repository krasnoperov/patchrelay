import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { AppConfig } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import {
  readIntegrationCandidateState,
  type IntegrationCandidateState,
} from "./integration-candidate-state.ts";
import { getGateCheckNames } from "./github-webhook-policy.ts";
import { serializeRunContext, type RunContext } from "./run-context.ts";
import { execCommand } from "./utils.ts";
import type { WorkflowTaskDispatcher } from "./workflow-task-dispatcher.ts";
import { workflowRunIntent, type WorkflowRunIntent } from "./workflow-intent.ts";
import { githubNativeSubjectId } from "./github-native-subject.ts";
import { discoverGitHubNativeCandidateRepairs } from "./github-native-candidate-discovery.ts";

const WRITER = "queue-health-monitor";

const QUEUE_HEALTH_GRACE_MS = 120_000;
const QUEUE_HEALTH_PROBE_FAILURE_COOLDOWN_MS = 300_000;
// An approved PR with red branch CI for at least this long is
// stuck at admission — operator notice is needed before the issue
// goes silent for hours.
const IN_REVIEW_STUCK_THRESHOLD_MS = 3 * 60 * 1000;
const IN_REVIEW_STUCK_FEED_COOLDOWN_MS = 15 * 60 * 1000;

export interface QueueHealthAdvancer {
  advanceIdleIssue(
    issue: IssueRecord,
    options?: {
      workflowIntent?: WorkflowRunIntent;
      clearFailureProvenance?: boolean;
      workflowOutcome?: "completed" | "failed" | "escalated";
      workflowOutcomeReason?: string;
    },
  ): void;
  workflowTaskDispatcher: WorkflowTaskDispatcher;
}

function isDuplicateProbe(
  issue: Pick<IssueRecord, "lastAttemptedFailureHeadSha" | "lastAttemptedFailureSignature">,
  context: RunContext | undefined,
): boolean {
  const signature = context?.failureSignature;
  const headSha = context?.failureHeadSha;
  if (!signature) return false;
  if (context?.requiresFreshHead === true) return false;
  return issue.lastAttemptedFailureSignature === signature
    && (headSha === undefined || issue.lastAttemptedFailureHeadSha === headSha);
}

export class QueueHealthMonitor {
  private readonly probeFailureFeedTimes = new Map<string, number>();
  private readonly inReviewStuckFeedTimes = new Map<string, number>();

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly config: AppConfig,
    private readonly advancer: QueueHealthAdvancer,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async reconcile(): Promise<void> {
    await this.adoptGitHubNativeRepairSubjects();
    for (const issue of this.db.issues.listAwaitingQueueIssues()) {
      await this.probeQueuedIssue(issue);
    }
    for (const issue of this.db.issues.listApprovedRedCiIssues()) {
      this.probeInReviewStuckIssue(issue);
    }
  }

  /**
   * Candidate refs are self-describing queue work. Adopt a repair subject even
   * when no Linear issue or prior PatchRelay delegation exists, but only after
   * re-validating exact-head approval and branch CI authority from GitHub.
   */
  private async adoptGitHubNativeRepairSubjects(): Promise<void> {
    const repairs = await discoverGitHubNativeCandidateRepairs({
      config: this.config,
      isTracked: (projectId, prNumber) => Boolean(this.db.issues.getIssueByProjectPrNumber(projectId, prNumber)),
    });
    for (const repair of repairs) {
      const subjectId = githubNativeSubjectId(repair.repoFullName, repair.prNumber);
      const adoption = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: repair.projectId,
          linearIssueId: subjectId,
          // This grants only candidate-repair authority. Feature work stays
          // undelegated even though the integration task is runnable.
          delegatedToPatchRelay: false,
          title: repair.title,
          branchName: repair.headBranch,
          prNumber: repair.prNumber,
          ...(repair.url ? { prUrl: repair.url } : {}),
          prState: "open",
          prIsDraft: false,
          prHeadSha: repair.headSha,
          prReviewState: "approved",
          prCheckStatus: "success",
          workflowOutcome: null,
        },
      });
      if (adoption.outcome !== "applied") continue;
      const issue = adoption.issue;
      this.dispatchCandidateRepair(issue, repair.candidate);
      this.logger.info(
        { projectId: repair.projectId, prNumber: repair.prNumber, subjectId, candidateSha: repair.candidate.candidateSha },
        "Queue health: adopted GitHub-native integration repair subject",
      );
    }
  }

  // Surface an approved PR whose red gate has blocked admission long enough
  // to require operator attention.
  private probeInReviewStuckIssue(issue: IssueRecord): void {
    if (!issue.prNumber) return;
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project) return;

    const reference = issue.lastGitHubFailureAt ?? issue.updatedAt;
    const stuckMs = Date.now() - Date.parse(reference);
    if (stuckMs < IN_REVIEW_STUCK_THRESHOLD_MS) return;

    const feedKey = `${issue.projectId}::${issue.linearIssueId}`;
    const lastFedAt = this.inReviewStuckFeedTimes.get(feedKey) ?? 0;
    if (Date.now() - lastFedAt < IN_REVIEW_STUCK_FEED_COOLDOWN_MS) return;
    this.inReviewStuckFeedTimes.set(feedKey, Date.now());

    const minutes = Math.round(stuckMs / 60_000);
    const failedCheck = issue.lastGitHubFailureCheckName ?? "branch CI";
    this.logger.warn(
      { issueKey: issue.issueKey, prNumber: issue.prNumber, stuckMs, failedCheck },
      "Queue health: approved PR is stuck at admission with red branch CI",
    );
    this.feed?.publish({
      level: "warn",
      kind: "github",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: "pr_open",
      status: "in_review_stuck",
      summary: `In Review · stuck at admission — PR #${issue.prNumber} has been approved with red ${failedCheck} for ${minutes} min`,
      detail: issue.lastGitHubFailureCheckUrl ?? undefined,
    });
  }

  private async probeQueuedIssue(issue: IssueRecord): Promise<void> {
    if (!issue.prNumber) return;
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project?.github?.repoFullName) return;

    const age = Date.now() - Date.parse(issue.updatedAt);
    if (age < QUEUE_HEALTH_GRACE_MS) return;

    const protocol = resolveMergeQueueProtocol(project);

    let pr: {
      state?: string;
      headRefOid?: string;
    };
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "state,headRefOid",
      ], { timeoutMs: 10_000 });
      pr = JSON.parse(stdout) as typeof pr;
    } catch (error) {
      this.logger.debug(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, error: error instanceof Error ? error.message : String(error) },
        "Queue health: failed to probe GitHub PR state",
      );
      const issueKey = `${issue.projectId}::${issue.linearIssueId}`;
      const lastFeedAt = this.probeFailureFeedTimes.get(issueKey) ?? 0;
      if (Date.now() - lastFeedAt >= QUEUE_HEALTH_PROBE_FAILURE_COOLDOWN_MS) {
        this.probeFailureFeedTimes.set(issueKey, Date.now());
        this.feed?.publish({
          level: "info",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "awaiting_queue",
          status: "queue_health_probe_failed",
          summary: `Queue health: failed to probe PR #${issue.prNumber}`,
        });
      }
      return;
    }

    this.probeFailureFeedTimes.delete(`${issue.projectId}::${issue.linearIssueId}`);

    if (pr.state === "MERGED") {
      const mergedCommit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: { projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" },
      });
      const merged = mergedCommit.outcome === "applied" ? mergedCommit.issue : issue;
      this.advancer.advanceIdleIssue(merged, {
        workflowOutcome: "completed",
        workflowOutcomeReason: "merge_queue_observed_merged",
        clearFailureProvenance: true,
      });
      return;
    }

    if (pr.state !== "OPEN") return;

    if (!pr.headRefOid) return;
    const candidate = await readIntegrationCandidateState({
      repoFullName: project.github.repoFullName,
      baseBranch: protocol.baseBranch ?? "main",
      prNumber: issue.prNumber,
      approvedHeadSha: pr.headRefOid,
      requiredChecks: getGateCheckNames(project),
    });
    if (!candidate || candidate.kind === "absent" || candidate.kind === "pending" || candidate.kind === "green") {
      return;
    }

    if (candidate.kind === "conflicted" || candidate.kind === "failed") {
      this.dispatchCandidateRepair(issue, candidate);
    }
  }

  private dispatchCandidateRepair(
    issue: IssueRecord,
    candidate: Extract<IntegrationCandidateState, { kind: "conflicted" | "failed" }>,
  ): void {
      const reason = candidate.kind === "conflicted" ? "candidate_conflict" : "candidate_ci_failed";
      const signature = `integration:${candidate.candidateSha}:${reason}`;
      const workflowRunContext: RunContext = {
        source: "queue_health_monitor",
        failureReason: reason,
        failureHeadSha: candidate.candidateSha,
        failureSignature: signature,
        candidateBranch: candidate.branch,
        candidateSha: candidate.candidateSha,
        approvedHeadSha: candidate.approvedHeadSha,
        integrationFailureKind: candidate.kind === "conflicted" ? "conflict" : "candidate_ci",
        ...(candidate.kind === "failed"
          ? {
              ciSnapshot: {
                headSha: candidate.candidateSha,
                gateCheckStatus: "failure" as const,
                capturedAt: new Date().toISOString(),
                failedChecks: candidate.failedChecks.map((check) => ({
                  name: check.name ?? "unknown",
                  status: "failure" as const,
                  ...(check.conclusion ? { conclusion: check.conclusion } : {}),
                  ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
                })),
                checks: candidate.checks.map((check) => ({
                  name: check.name ?? "unknown",
                  status: candidate.failedChecks.includes(check) ? "failure" as const : "success" as const,
                  ...(check.conclusion ? { conclusion: check.conclusion } : {}),
                  ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
                })),
              },
            }
          : {}),
      };

      if (isDuplicateProbe(issue, workflowRunContext)) {
        return;
      }

      const probedCommit = this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          // Bind the candidate incident to the same live PR head used by the
          // authority gate, including for older tracked rows that missed a
          // pull_request webhook.
          prHeadSha: candidate.approvedHeadSha,
          lastGitHubFailureSource: "queue_eviction",
          // queue_eviction is retained as the persisted compatibility bucket;
          // GitHub candidate state, not this value, is the control protocol.
          lastGitHubFailureHeadSha: candidate.candidateSha,
          lastGitHubFailureSignature: signature,
          lastGitHubFailureContextJson: serializeRunContext(workflowRunContext, "queue health repair context"),
          lastAttemptedFailureHeadSha: candidate.candidateSha,
          lastAttemptedFailureSignature: signature,
        },
      });
      const probed = probedCommit.outcome === "applied" ? probedCommit.issue : issue;
      this.advancer.advanceIdleIssue(probed, {
        workflowIntent: workflowRunIntent("integration_repair", workflowRunContext),
      });
      this.logger.info(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, candidateSha: candidate.candidateSha, candidateBranch: candidate.branch, reason },
        "Queue health: integration candidate needs repair",
      );
      this.feed?.publish({
        level: "warn",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "repairing_queue",
        status: candidate.kind === "failed" ? "candidate_ci_failure_detected" : "candidate_conflict_detected",
        summary: candidate.kind === "failed"
          ? `Integration candidate CI failed for PR #${issue.prNumber}; dispatching candidate-only repair`
          : `Integration candidate conflicts for PR #${issue.prNumber}; dispatching candidate-only repair`,
      });
  }
}
