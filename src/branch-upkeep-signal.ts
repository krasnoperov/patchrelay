import type { PatchRelayDatabase } from "./db.ts";

export interface BranchUpkeepObservationInput {
  /** Base/parent branch the child must rebase onto. */
  parentBranch: string;
  /** Parent head the child needs to move past (omitted when unknown, e.g. a
   *  review-fix left the PR dirty against its base with no parent PR). */
  parentHeadSha?: string | undefined;
  /** The child's own current head — self-closes the task once a new head lands. */
  childHeadSha?: string | undefined;
  childPrNumber?: number | undefined;
  /**
   * SHA that scopes the dedupe key. Stack-coordination dedupes on the parent
   * head (one wake per parent advance); the review-fix-dirty / interrupted-retry
   * paths dedupe on the child's own head. Defaults to `childHeadSha`.
   */
  dedupeSha?: string | undefined;
}

/**
 * Append the durable `github.parent_head_moved` observation that
 * `deriveWorkflowTasks` turns into a `run:branch_upkeep` task (S2). Shared by
 * every writer that used to drive branch upkeep through the legacy
 * `pending_run_type` column / session events so the observation → task path is
 * the single source of the upkeep run. Deduped by the child + scoping SHA, so
 * repeated signals on the same head collapse and a new child head self-closes
 * the stale one.
 */
export function appendBranchUpkeepObservation(
  db: PatchRelayDatabase,
  issue: { projectId: string; linearIssueId: string },
  input: BranchUpkeepObservationInput,
): void {
  const dedupeSha = input.dedupeSha ?? input.childHeadSha;
  db.workflowObservations.appendObservation({
    projectId: issue.projectId,
    subjectId: issue.linearIssueId,
    source: "github",
    type: "github.parent_head_moved",
    payloadJson: JSON.stringify({
      parentBranch: input.parentBranch,
      ...(input.parentHeadSha ? { parentHeadSha: input.parentHeadSha } : {}),
      ...(input.childPrNumber !== undefined ? { childPrNumber: input.childPrNumber } : {}),
      ...(input.childHeadSha ? { childHeadSha: input.childHeadSha } : {}),
    }),
    dedupeKey: `branch_upkeep:${issue.linearIssueId}:${dedupeSha ?? "unknown-sha"}`,
  });
}
