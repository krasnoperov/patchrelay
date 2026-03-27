import type { CIRunner } from "../interfaces.ts";
import type { CIStatus } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * CI runner that polls GitHub Actions via the gh CLI.
 * triggerRun is a no-op — force-pushing the branch triggers CI automatically.
 */
export class GitHubActionsRunner implements CIRunner {
  constructor(
    private readonly repoFullName: string,
    private readonly requiredChecks: string[] = [],
  ) {}

  async triggerRun(branch: string, _sha: string): Promise<string> {
    // CI is triggered by the push in ShellGitOperations. We just need
    // an ID to poll. Use the branch name as a synthetic run ID — we'll
    // poll by branch, not by run ID.
    return `branch:${branch}`;
  }

  async getStatus(runId: string): Promise<CIStatus> {
    // runId format: "branch:{branchName}"
    const branch = runId.replace(/^branch:/, "");

    const result = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/commits/${branch}/check-runs`,
      "--jq", ".check_runs",
    ], { allowNonZero: true });

    if (result.exitCode !== 0) return "pending";

    try {
      const checkRuns = JSON.parse(result.stdout) as Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;

      if (checkRuns.length === 0) return "pending";

      const relevant = this.requiredChecks.length > 0
        ? checkRuns.filter((c) => this.requiredChecks.includes(c.name))
        : checkRuns;

      if (relevant.length === 0) return "pending";

      // If any are still running, the overall status is pending.
      if (relevant.some((c) => c.status !== "completed")) return "pending";

      // If any failed, the overall status is fail.
      if (relevant.some((c) => c.conclusion === "failure" || c.conclusion === "timed_out")) return "fail";

      // All completed and none failed.
      return "pass";
    } catch {
      return "pending";
    }
  }

  async cancelRun(_runId: string): Promise<void> {
    // GitHub Actions runs cancel automatically when the branch is force-pushed.
    // No explicit cancel needed for Phase 1.
  }

  async getMainStatus(baseBranch: string): Promise<CIStatus> {
    return this.getStatus(`branch:${baseBranch}`);
  }
}
