import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { AppConfig } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { buildRepairWakeDedupeKey } from "./reactive-wake-keys.ts";
import { execCommand } from "./utils.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";

const QUEUE_HEALTH_GRACE_MS = 120_000;
const QUEUE_HEALTH_PROBE_FAILURE_COOLDOWN_MS = 300_000;
// Plan §6.2: an approved PR with red branch CI for >= this long is
// stuck at admission — operator notice is needed before the issue
// goes silent for hours.
const IN_REVIEW_STUCK_THRESHOLD_MS = 30 * 60 * 1000;
const IN_REVIEW_STUCK_FEED_COOLDOWN_MS = 30 * 60 * 1000;

export interface QueueHealthAdvancer {
  advanceIdleIssue(
    issue: IssueRecord,
    newState: FactoryState,
    options?: {
      pendingRunType?: RunType;
      pendingRunContext?: Record<string, unknown>;
      clearFailureProvenance?: boolean;
    },
  ): void;
  wakeDispatcher: WakeDispatcher;
}

function isDuplicateProbe(
  issue: Pick<IssueRecord, "lastAttemptedFailureHeadSha" | "lastAttemptedFailureSignature">,
  context: Record<string, unknown> | undefined,
): boolean {
  const signature = typeof context?.failureSignature === "string" ? context.failureSignature : undefined;
  const headSha = typeof context?.failureHeadSha === "string" ? context.failureHeadSha : undefined;
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
    for (const issue of this.db.issues.listAwaitingQueueIssues()) {
      await this.probeQueuedIssue(issue);
    }
    for (const issue of this.db.issues.listApprovedRedCiIssues()) {
      this.probeInReviewStuckIssue(issue);
    }
  }

  // Plan §6.2: emit IN_REVIEW_STUCK when an approved PR has a red gate
  // for more than 30 minutes. Consequence of plan §4.3 — branch CI
  // failures while approved no longer trigger ci_repair, so the
  // condition is otherwise invisible to the operator.
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
      mergeable?: string;
      mergeStateStatus?: string;
      headRefOid?: string;
    };
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "state,mergeable,mergeStateStatus,headRefOid",
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
      const merged = this.db.issues.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
      this.advancer.advanceIdleIssue(merged, "done", { clearFailureProvenance: true });
      return;
    }

    if (pr.state !== "OPEN") return;

    const isDirty = pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING";
    let hasEvictionCheckRun = false;
    if (!isDirty) {
      try {
        const { stdout: checksOut } = await execCommand("gh", [
          "api", `repos/${project.github.repoFullName}/commits/${pr.headRefOid}/check-runs`,
          "--jq", `.check_runs[] | select(.name == "${protocol.evictionCheckName}" and .conclusion == "failure") | .name`,
        ], { timeoutMs: 10_000 });
        hasEvictionCheckRun = checksOut.trim().length > 0;
      } catch {
        // Best-effort check.
      }
    }

    if (isDirty || hasEvictionCheckRun) {
      const headRefOid = pr.headRefOid ?? "unknown";
      const reason = hasEvictionCheckRun ? "queue_eviction_missed" : "preemptive_conflict";
      const signature = hasEvictionCheckRun
        ? `same_head_queue_eviction:${headRefOid}`
        : `preemptive_queue_conflict:${headRefOid}`;
      const pendingRunContext: Record<string, unknown> = {
        source: "queue_health_monitor",
        failureReason: reason,
        failureHeadSha: headRefOid,
        failureSignature: signature,
        ...(hasEvictionCheckRun
          ? {
              requiresFreshHead: true,
              promptContext: [
                `merge-steward/queue is already failed on PR #${issue.prNumber} at head ${headRefOid}.`,
                "merge-steward will not re-admit the same evicted head SHA.",
                "Preserve the approved diff, but publish a new head SHA on the existing PR branch before finishing.",
                "If rebasing onto the current base produces no content change, create an empty queue-kick commit.",
              ].join(" "),
            }
          : {}),
      };

      if (isDuplicateProbe(issue, pendingRunContext)) {
        return;
      }

      const probed = this.db.issues.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastAttemptedFailureHeadSha: headRefOid,
        lastAttemptedFailureSignature: signature,
      });
      this.advancer.wakeDispatcher.recordEventAndDispatch(issue.projectId, issue.linearIssueId, {
        eventType: "merge_steward_incident",
        eventJson: JSON.stringify(pendingRunContext),
        dedupeKey: buildRepairWakeDedupeKey({
          scope: "queue_health",
          runType: "queue_repair",
          linearIssueId: issue.linearIssueId,
          signature,
        }),
      });
      this.advancer.advanceIdleIssue(probed, "repairing_queue");
      this.logger.info(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, headRefOid, reason },
        "Queue health: queue issue detected, dispatching repair",
      );
      this.feed?.publish({
        level: "warn",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "repairing_queue",
        status: hasEvictionCheckRun ? "queue_health_eviction_detected" : "queue_health_conflict_detected",
        summary: hasEvictionCheckRun
          ? `Queue health: missed eviction detected on PR #${issue.prNumber}, dispatching repair`
          : `Queue health: merge conflict detected on PR #${issue.prNumber}, dispatching preemptive repair`,
      });
    }
  }
}
