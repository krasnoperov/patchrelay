import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

const WRITER = "github-webhook-stack-coordination";

// Plan §8.3-8.4: when a parent PR's head moves (review-fix push,
// eviction repair, base-branch update), child PRs stacked on it
// become stale. Patchrelay treats this as a wake event for each
// matching child and enqueues a `branch_upkeep` run to rebase the
// child onto the new parent head.
export function maybeFanChildRebaseWakes(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed?: OperatorEventFeed;
  wakeDispatcher: WakeDispatcher;
  event: NormalizedGitHubEvent;
}): void {
  const { db, logger, feed, wakeDispatcher, event } = params;
  if (event.triggerEvent !== "pr_synchronize") return;
  if (!event.branchName) return;

  const children = db.issues.listIssuesWithParentBranch(event.branchName);
  if (children.length === 0) return;

  for (const child of children) {
    if (child.activeRunId !== undefined) {
      // Child already has a run going; let it complete and the next
      // reconcile cycle pick up the new parent state.
      logger.debug(
        { parentBranch: event.branchName, childIssue: child.issueKey, childRunId: child.activeRunId },
        "Skipping child-rebase wake — child has an active run",
      );
      continue;
    }
    db.issueSessions.commitIssueState({
      writer: WRITER,
      update: {
        projectId: child.projectId,
        linearIssueId: child.linearIssueId,
        pendingRunType: "branch_upkeep",
      },
    });
    // S2: append the durable signal the v2 workflow-task path derives
    // `run:branch_upkeep` from. The legacy `pending_run_type` write above is
    // kept intentionally this stage (dual path), but the observation + reconcile
    // materialize a runnable workflow task so the `workflow_task` dispatch rung
    // — which outranks the legacy column in both resolvers — wins. Repeated
    // syncs on the same parent head dedupe; a new parent head is a new
    // observation (and a new child head self-closes the stale one).
    db.workflowObservations.appendObservation({
      projectId: child.projectId,
      subjectId: child.linearIssueId,
      source: "github",
      type: "github.parent_head_moved",
      payloadJson: JSON.stringify({
        parentBranch: event.branchName,
        ...(event.headSha ? { parentHeadSha: event.headSha } : {}),
        ...(child.prNumber !== undefined ? { childPrNumber: child.prNumber } : {}),
        ...(child.prHeadSha ? { childHeadSha: child.prHeadSha } : {}),
      }),
      dedupeKey: `branch_upkeep:${child.linearIssueId}:${event.headSha ?? "unknown-sha"}`,
    });
    const refreshedChild = db.issues.getIssue(child.projectId, child.linearIssueId) ?? child;
    reconcileWorkflowTasksForIssue(db, refreshedChild);
    // The pending_run_type field / observation above aren't an in-memory
    // enqueue, so we still need an explicit dispatch call. dispatchIfWakePending
    // resolves the runnable workflow task (falling back to the legacy column if
    // reconciliation could not materialize one).
    wakeDispatcher.dispatchIfWakePending(child.projectId, child.linearIssueId);
    logger.info(
      {
        parentBranch: event.branchName,
        parentHeadSha: event.headSha,
        childIssue: child.issueKey,
        childPrNumber: child.prNumber,
      },
      "Enqueued branch_upkeep on stacked child after parent PR head moved",
    );
    feed?.publish({
      level: "info",
      kind: "github",
      summary: `Parent PR head moved on ${event.branchName} — branch_upkeep queued for child PR #${child.prNumber ?? "?"}`,
      ...(child.issueKey ? { issueKey: child.issueKey } : {}),
      ...(child.projectId ? { projectId: child.projectId } : {}),
    });
  }
}
