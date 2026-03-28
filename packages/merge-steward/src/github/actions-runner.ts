import type { CIRunner } from "../interfaces.ts";
import type { CIStatus } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * CI runner that polls GitHub Actions via the gh CLI.
 * triggerRun is a no-op — force-pushing the branch triggers CI automatically.
 * Polls by commit SHA (not branch name) to avoid URL-encoding issues with
 * branch names containing slashes and to avoid stale results after force-push.
 */
export class GitHubActionsRunner implements CIRunner {
  constructor(
    private readonly repoFullName: string,
    private readonly requiredChecks: string[] = [],
  ) {}

  async triggerRun(_branch: string, sha: string): Promise<string> {
    // CI is triggered by the push. Return the SHA as the poll key.
    return `sha:${sha}`;
  }

  async getStatus(runId: string): Promise<CIStatus> {
    const sha = runId.replace(/^sha:/, "");

    const result = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/commits/${sha}/check-runs`,
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

      if (relevant.some((c) => c.status !== "completed")) return "pending";
      if (relevant.some((c) => c.conclusion === "failure" || c.conclusion === "cancelled" || c.conclusion === "timed_out")) return "fail";

      return "pass";
    } catch {
      return "pending";
    }
  }

  async cancelRun(_runId: string): Promise<void> {
    // GitHub Actions runs cancel automatically when the branch is force-pushed.
  }

  async getMainStatus(baseBranch: string): Promise<CIStatus> {
    // For main branch, we need to resolve the SHA first since we can't
    // use branch name in the URL (may contain slashes).
    const result = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
      "--jq", ".object.sha",
    ], { allowNonZero: true });

    if (result.exitCode !== 0 || !result.stdout.trim()) return "pending";
    return this.getStatus(`sha:${result.stdout.trim()}`);
  }
}
