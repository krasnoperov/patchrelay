import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { WakeDispatcher } from "./wake-dispatcher.ts";

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
    // The pending_run_type field above isn't an event, so we still need
    // an explicit dispatch call. dispatchIfWakePending will pick up the
    // wake derived from the legacy pendingRunType column.
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
