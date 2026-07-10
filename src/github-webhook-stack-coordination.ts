import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { WorkflowTaskDispatcher } from "./workflow-task-dispatcher.ts";
import { appendBranchUpkeepObservation } from "./branch-upkeep-signal.ts";
import { reconcileWorkflowTasksForIssue } from "./workflow-task-reconciler.ts";

// Plan §8.3-8.4: when a parent PR's head moves (review-fix push,
// eviction repair, base-branch update), child PRs stacked on it
// become stale. Patchrelay treats this as a workflow signal for each
// matching child and enqueues a `branch_upkeep` run to rebase the
// child onto the new parent head.
export function maybeFanChildRebaseDispatches(params: {
  db: PatchRelayDatabase;
  logger: Logger;
  feed?: OperatorEventFeed;
  workflowTaskDispatcher: WorkflowTaskDispatcher;
  event: NormalizedGitHubEvent;
}): void {
  const { db, logger, feed, workflowTaskDispatcher, event } = params;
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
        "Skipping child-rebase dispatch because child has an active run",
      );
      continue;
    }
    // Append the durable signal the workflow-task path derives
    // `run:branch_upkeep` from and reconcile a runnable workflow task. The
    // `workflow_task` dispatch path is the only source. Repeated syncs on the same parent
    // head dedupe (keyed on the parent head); a new child head self-closes the
    // stale one.
    appendBranchUpkeepObservation(db, child, {
      parentBranch: event.branchName,
      ...(event.headSha ? { parentHeadSha: event.headSha } : {}),
      ...(child.prNumber !== undefined ? { childPrNumber: child.prNumber } : {}),
      ...(child.prHeadSha ? { childHeadSha: child.prHeadSha } : {}),
      dedupeSha: event.headSha,
    });
    const refreshedChild = db.issues.getIssue(child.projectId, child.linearIssueId) ?? child;
    reconcileWorkflowTasksForIssue(db, refreshedChild);
    // The observation append is not an in-memory enqueue, so we still need an
    // explicit dispatch call. dispatchIfWorkflowTaskPending resolves the runnable
    // workflow task materialized by the reconcile above.
    workflowTaskDispatcher.dispatchIfWorkflowTaskPending(child.projectId, child.linearIssueId);
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
