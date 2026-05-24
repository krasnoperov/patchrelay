import type { Logger } from "pino";
import type { ProjectConfig } from "./workflow-types.ts";
import { resolveMergeQueueProtocol } from "./merge-queue-protocol.ts";
import { execCommand } from "./utils.ts";

// How long an issue may sit in `deploying` before we give up watching and
// advance to `done` anyway. The change is already on `main`; if no deploy
// run ever shows up (no workflow triggered, or it was superseded and GC'd),
// we must not strand the issue. 20 minutes comfortably covers a queued +
// running deploy without leaving issues stuck for hours.
export const DEPLOY_WATCH_TIMEOUT_MS = 20 * 60_000;

// Small grace window: a deploy run triggered by the merge push can be
// created a few seconds before we stamp `deployStartedAt`. Don't exclude it.
const SINCE_GRACE_MS = 2 * 60_000;

export type DeployOutcome = "succeeded" | "failed" | "pending";

export interface DeployRunSummary {
  status: string;        // queued | in_progress | completed | ...
  conclusion: string | null; // success | failure | cancelled | ...
  createdAt: string;     // ISO
}

/**
 * Whether a merge should enter the `deploying` watch state. Opt-in per
 * project via `github.deployWorkflowName`; absent → advance straight to
 * `done` (today's behavior, no risk of stranding issues).
 */
export function isDeployTrackingEnabled(project: ProjectConfig | undefined): boolean {
  return Boolean(resolveMergeQueueProtocol(project).deployWorkflowName);
}

export function resolvePostMergeFactoryState(project: ProjectConfig | undefined): "deploying" | "done" {
  return isDeployTrackingEnabled(project) ? "deploying" : "done";
}

/**
 * Decide the deploy outcome from the recent runs of the deploy workflow on
 * the base branch. Pure and total so it can be unit-tested without GitHub.
 *
 * Only runs created at/after `sinceIso` (minus a small grace) count — any
 * deploy on `main` after the merge includes the merged change, since `main`
 * only moves forward. The most recent decisive run wins; cancelled/skipped
 * runs are ignored (a later run supersedes them).
 */
export function interpretDeployRuns(runs: DeployRunSummary[], sinceIso: string): DeployOutcome {
  const sinceMs = Date.parse(sinceIso);
  const cutoff = Number.isFinite(sinceMs) ? sinceMs - SINCE_GRACE_MS : -Infinity;
  const relevant = runs
    .filter((r) => {
      const t = Date.parse(r.createdAt);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  for (const run of relevant) {
    const conclusion = (run.conclusion ?? "").toLowerCase();
    const status = run.status.toLowerCase();
    if (status !== "completed") {
      // queued / in_progress / waiting / requested → still deploying.
      return "pending";
    }
    if (conclusion === "success") return "succeeded";
    if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure") {
      return "failed";
    }
    // cancelled / skipped / neutral / stale / action_required — not decisive;
    // look at the next-most-recent run.
  }
  return "pending";
}

/**
 * Query the deploy workflow's recent runs on the base branch and interpret
 * them. Returns "pending" on any query error so the watcher simply retries
 * next tick (and the timeout backstops a permanently-absent deploy).
 */
export async function evaluateDeploy(params: {
  repoFullName: string;
  workflowName: string;
  baseBranch: string;
  sinceIso: string;
  logger?: Logger;
}): Promise<DeployOutcome> {
  const { repoFullName, workflowName, baseBranch, sinceIso, logger } = params;
  try {
    const { stdout } = await execCommand("gh", [
      "run", "list",
      "--repo", repoFullName,
      "--workflow", workflowName,
      "--branch", baseBranch,
      "--json", "status,conclusion,createdAt",
      "-L", "15",
    ], { timeoutMs: 15_000 });
    const runs = JSON.parse(stdout) as DeployRunSummary[];
    if (!Array.isArray(runs)) return "pending";
    return interpretDeployRuns(runs, sinceIso);
  } catch (error) {
    logger?.debug(
      { repoFullName, workflowName, error: error instanceof Error ? error.message : String(error) },
      "Deploy watch query failed; will retry",
    );
    return "pending";
  }
}

/** Default watcher used in production (real `gh` queries). */
export type DeployEvaluator = (params: {
  repoFullName: string;
  workflowName: string;
  baseBranch: string;
  sinceIso: string;
  logger?: Logger;
}) => Promise<DeployOutcome>;
