import type { CIRunner } from "../interfaces.ts";
import type { CIStatus } from "../types.ts";
import { exec } from "../exec.ts";

function normalizeCheckName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * CI runner that polls GitHub Actions via the gh CLI.
 * triggerRun is a no-op — force-pushing the branch triggers CI automatically.
 * Polls by commit SHA (not branch name) to avoid URL-encoding issues with
 * branch names containing slashes and to avoid stale results after force-push.
 */
export class GitHubActionsRunner implements CIRunner {
  constructor(
    private readonly repoFullName: string,
    private readonly getRequiredChecks: () => string[] = () => [],
    private readonly shouldRequireAllChecksOnEmptyRequiredSet: () => boolean = () => false,
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
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) return "pending";

    try {
      const checkRuns = JSON.parse(result.stdout) as Array<{
        name: string;
        status: string;
        conclusion: string | null;
      }>;

      if (checkRuns.length === 0) return "pending";

      const requiredChecks = this.getRequiredChecks();
      const normalizedRequired = requiredChecks.map(normalizeCheckName);
      const hasRequired = requiredChecks.length > 0;
      const requireAllChecks = !hasRequired && this.shouldRequireAllChecksOnEmptyRequiredSet();
      const relevant = hasRequired
        ? checkRuns.filter((c) => normalizedRequired.includes(normalizeCheckName(c.name)))
        : checkRuns;

      if (relevant.length === 0) return "pending";

      if (relevant.some((c) => c.status !== "completed")) return "pending";
      // REST API returns lowercase conclusions.  For required checks,
      // "skipped" is rejected — a gate job can report success while the
      // underlying required job was skipped by a workflow branch filter,
      // letting untested code through.  When no required checks are
      // configured, "skipped" is accepted as passing, matching
      // mapRestConclusion in pr-client.ts — otherwise getMainStatus reports
      // "fail" whenever main has conditional workflow jobs that are skipped
      // (e.g. deploy-stage on main), even though listChecksForRef treats
      // those same checks as success, producing a "main_broken" block with
      // an empty failing-check list and stalling the queue.
      const acceptSkipped = !hasRequired && !requireAllChecks;
      if (relevant.some((c) => {
        if (c.conclusion === "success" || c.conclusion === "neutral") return false;
        if (acceptSkipped && c.conclusion === "skipped") return false;
        return true;
      })) return "fail";

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
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0 || !result.stdout.trim()) return "pending";
    return this.getStatus(`sha:${result.stdout.trim()}`);
  }
}
