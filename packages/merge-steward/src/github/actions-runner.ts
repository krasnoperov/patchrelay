import type { CIRunner } from "../interfaces.ts";
import type { CIStatus, RequiredCheck } from "../types.ts";
import { exec } from "../exec.ts";
import { evaluateCheckPolicy, mapGitHubCheckConclusion } from "../check-policy.ts";

interface GitHubCheckRun {
  id?: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  app?: { id?: number };
}

function actionsWorkflowRunId(detailsUrl: string | null | undefined): number | undefined {
  const match = detailsUrl?.match(/\/actions\/runs\/(\d+)(?:\/|$)/);
  if (!match) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
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
    private readonly getRequiredChecks: () => Array<string | RequiredCheck> = () => [],
    private readonly shouldRequireAllChecksOnEmptyRequiredSet: () => boolean = () => false,
  ) {}

  async triggerRun(_branch: string, sha: string): Promise<string> {
    // CI is triggered by the push. Return the SHA as the poll key.
    return `sha:${sha}`;
  }

  async rerunRun(_runId: string, _branch: string, sha: string): Promise<string> {
    const checkRuns = await this.listCheckRuns(sha);
    const evaluation = this.evaluate(checkRuns);
    const byCheckRunId = new Map(
      checkRuns
        .filter((check): check is GitHubCheckRun & { id: number } => typeof check.id === "number")
        .map((check) => [check.id, check]),
    );
    const workflowRunIds = new Set<number>();
    for (const failure of evaluation.failing) {
      const workflowRunId = actionsWorkflowRunId(
        failure.runId === undefined ? undefined : byCheckRunId.get(failure.runId)?.details_url,
      );
      if (!workflowRunId) {
        throw new Error(
          `Required failing check ${failure.name} is not tied to a rerunnable GitHub Actions workflow`,
        );
      }
      workflowRunIds.add(workflowRunId);
    }
    if (workflowRunIds.size === 0) {
      throw new Error(`No required failed workflow run can be rerun for candidate ${sha.slice(0, 12)}`);
    }

    for (const workflowRunId of workflowRunIds) {
      const rerun = await exec("gh", [
        "api",
        "--method", "POST",
        `repos/${this.repoFullName}/actions/runs/${workflowRunId}/rerun-failed-jobs`,
      ], { allowNonZero: true, githubRepoFullName: this.repoFullName });
      if (rerun.exitCode !== 0) {
        throw new Error(`GitHub rejected workflow rerun ${workflowRunId} for candidate ${sha.slice(0, 12)}`);
      }
    }
    return `sha:${sha}`;
  }

  async getStatus(runId: string): Promise<CIStatus> {
    const sha = runId.replace(/^sha:/, "");
    try {
      return this.evaluate(await this.listCheckRuns(sha)).status;
    } catch {
      return "pending";
    }
  }

  private async listCheckRuns(sha: string): Promise<GitHubCheckRun[]> {
    const result = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/commits/${sha}/check-runs?per_page=100`,
      "--jq", ".check_runs",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) {
      throw new Error(`Could not list check runs for candidate ${sha.slice(0, 12)}`);
    }

    try {
      return JSON.parse(result.stdout) as GitHubCheckRun[];
    } catch {
      throw new Error(`GitHub returned malformed check runs for candidate ${sha.slice(0, 12)}`);
    }
  }

  private evaluate(checkRuns: GitHubCheckRun[]) {
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
    );
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
