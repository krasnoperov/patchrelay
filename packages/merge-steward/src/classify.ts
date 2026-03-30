import type { CheckResult, FailureClass } from "./types.ts";

/**
 * Classify a CI failure by comparing branch checks against main baseline.
 *
 * - main_broken: the same checks that fail on the branch also fail on main
 * - branch_local: checks fail on the branch but pass on main (PR's own fault)
 * - integration_conflict: default when no baseline is available
 */
export function classifyFailure(
  branchChecks: CheckResult[],
  mainChecks: CheckResult[],
): FailureClass {
  const failedOnBranch = branchChecks.filter((c) => c.conclusion === "failure");
  if (failedOnBranch.length === 0) return "integration_conflict";

  if (mainChecks.length === 0) {
    // No baseline — can't distinguish. Default to integration_conflict
    // since we only classify after rebase.
    return "integration_conflict";
  }

  const failedOnMain = mainChecks.filter((c) => c.conclusion === "failure");
  const mainFailedNames = new Set(failedOnMain.map((c) => c.name));

  // If every branch failure also fails on main, main is broken.
  const allOnMain = failedOnBranch.every((c) => mainFailedNames.has(c.name));
  if (allOnMain && failedOnMain.length > 0) return "main_broken";

  // If none of the branch failures appear on main, it's the branch's fault.
  const noneOnMain = failedOnBranch.every((c) => !mainFailedNames.has(c.name));
  if (noneOnMain) return "branch_local";

  // Mixed: some fail on main, some don't. Treat as integration_conflict.
  return "integration_conflict";
}
