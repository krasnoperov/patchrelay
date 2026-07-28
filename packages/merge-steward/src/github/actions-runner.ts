import type { CIRunner } from "../interfaces.ts";
import type { CIStatus, RequiredCheck } from "../types.ts";
import { exec } from "../exec.ts";
import { evaluateCheckPolicy, mapGitHubCheckConclusion } from "../check-policy.ts";

/**
 * CI runner that polls GitHub Actions via the gh CLI.
 * triggerRun is a no-op — force-pushing the branch triggers CI automatically.
 * Polls by commit SHA (not branch name) to avoid URL-encoding issues with
 * branch names containing slashes and to avoid stale results after force-push.
 */
export class GitHubActionsRunner implements CIRunner {
  constructor(
    private readonly repoFullName: string,
    private readonly getRequiredChecks: () => Array<string | RequiredCheck> = () => [],
    private readonly shouldRequireAllChecksOnEmptyRequiredSet: () => boolean = () => false,
  ) {}

  async triggerRun(_branch: string, sha: string): Promise<string> {
    // CI is triggered by the push. Return the SHA as the poll key.
    return `sha:${sha}`;
  }

  async rerunRun(_runId: string, _branch: string, sha: string): Promise<string> {
    const listed = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });
    if (listed.exitCode !== 0) {
      throw new Error(`Could not list workflow runs for candidate ${sha.slice(0, 12)}`);
    }

    let workflowRuns: Array<{ id?: number; status?: string; conclusion?: string | null }>;
    try {
      workflowRuns = (JSON.parse(listed.stdout) as { workflow_runs?: typeof workflowRuns }).workflow_runs ?? [];
    } catch {
      throw new Error(`GitHub returned malformed workflow runs for candidate ${sha.slice(0, 12)}`);
    }
    const failedConclusions = new Set([
      "failure",
      "cancelled",
      "timed_out",
      "stale",
      "action_required",
    ]);
    const latestFailed = workflowRuns
      .filter((run) =>
        typeof run.id === "number"
        && run.status === "completed"
        && failedConclusions.has(run.conclusion ?? ""))
      .sort((left, right) => (right.id ?? 0) - (left.id ?? 0))[0];
    if (!latestFailed?.id) {
      throw new Error(`No failed workflow run can be rerun for candidate ${sha.slice(0, 12)}`);
    }

    const rerun = await exec("gh", [
      "api",
      "--method", "POST",
      `repos/${this.repoFullName}/actions/runs/${latestFailed.id}/rerun-failed-jobs`,
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });
    if (rerun.exitCode !== 0) {
      throw new Error(`GitHub rejected workflow rerun ${latestFailed.id} for candidate ${sha.slice(0, 12)}`);
    }
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
        id?: number;
        name: string;
        status: string;
        conclusion: string | null;
        app?: { id?: number };
      }>;
      const required = this.getRequiredChecks().map((check): RequiredCheck =>
        typeof check === "string" ? { name: check, appId: null } : check);
      const checks = checkRuns.map((check) => ({
        name: check.name,
        conclusion: mapGitHubCheckConclusion(check.status, check.conclusion),
        ...(typeof check.app?.id === "number" ? { appId: check.app.id } : {}),
        ...(typeof check.id === "number" ? { runId: check.id } : {}),
      }));
      return evaluateCheckPolicy(
        required,
        this.shouldRequireAllChecksOnEmptyRequiredSet(),
        checks,
      ).status;
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
