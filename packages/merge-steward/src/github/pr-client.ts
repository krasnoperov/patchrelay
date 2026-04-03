import type { GitHubPRApi } from "../interfaces.ts";
import type { CheckResult, PRStatus } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * GitHub PR operations via gh CLI and REST API.
 *
 * External contract:
 *  - REST check-runs API uses lowercase `conclusion` (success/failure/cancelled/…).
 *
 * We rely on the REST API here because `gh pr checks --json` is not available
 * on every gh version we support operationally.
 */
export class GitHubPRClient implements GitHubPRApi {
  constructor(private readonly repoFullName: string) {}

  async mergePR(prNumber: number): Promise<void> {
    await exec("gh", [
      "pr", "merge", String(prNumber),
      "--repo", this.repoFullName,
      "--merge", "--delete-branch",
    ], { timeoutMs: 60_000, githubRepoFullName: this.repoFullName });
  }

  async getStatus(prNumber: number): Promise<PRStatus> {
    const result = await exec("gh", [
      "pr", "view", String(prNumber),
      "--repo", this.repoFullName,
      "--json", "number,headRefName,headRefOid,reviewDecision,state,mergeStateStatus",
    ], { githubRepoFullName: this.repoFullName });

    const data = JSON.parse(result.stdout) as {
      number: number;
      headRefName: string;
      headRefOid: string;
      reviewDecision: string;
      state: string;
      mergeStateStatus?: string;
    };

    return {
      number: data.number,
      branch: data.headRefName,
      headSha: data.headRefOid,
      mergeable: data.state === "OPEN",
      mergeStateStatus: data.mergeStateStatus,
      reviewApproved: data.reviewDecision === "APPROVED",
      merged: data.state === "MERGED",
    };
  }

  async listChecks(prNumber: number): Promise<CheckResult[]> {
    const status = await this.getStatus(prNumber);
    return await this.listChecksForRef(status.headSha);
  }

  async listChecksForRef(ref: string): Promise<CheckResult[]> {
    // Callers pass remote-tracking refs like "origin/main"; the API needs "main" or a SHA.
    const apiRef = ref.replace(/^origin\//, "");
    const result = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/commits/${apiRef}/check-runs`,
      "--jq", ".check_runs",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) return [];

    try {
      const checks = JSON.parse(result.stdout) as Array<{
        name: string;
        status?: string;
        conclusion: string | null;
        html_url?: string;
      }>;
      return checks
        .map((c) => ({
          name: c.name,
          conclusion: mapRestConclusion(c.status, c.conclusion),
          ...(c.html_url ? { url: c.html_url } : {}),
        }));
    } catch {
      return [];
    }
  }

  async listOpenPRsWithLabel(label: string): Promise<Array<{ number: number; branch: string; headSha: string }>> {
    const result = await exec("gh", [
      "pr", "list",
      "--repo", this.repoFullName,
      "--label", label,
      "--state", "open",
      "--json", "number,headRefName,headRefOid",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) return [];

    try {
      const data = JSON.parse(result.stdout) as Array<{
        number: number;
        headRefName: string;
        headRefOid: string;
      }>;
      return data.map((pr) => ({ number: pr.number, branch: pr.headRefName, headSha: pr.headRefOid }));
    } catch {
      return [];
    }
  }

  async deleteBranch(prNumber: number): Promise<void> {
    const status = await this.getStatus(prNumber);
    await exec("gh", [
      "api", "--method", "DELETE",
      `repos/${this.repoFullName}/git/refs/heads/${status.branch}`,
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });
  }

  async findPRByBranch(branch: string): Promise<number | null> {
    const result = await exec("gh", [
      "pr", "list",
      "--repo", this.repoFullName,
      "--head", branch,
      "--state", "open",
      "--json", "number",
      "--limit", "1",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) return null;

    try {
      const prs = JSON.parse(result.stdout) as Array<{ number: number }>;
      return prs[0]?.number ?? null;
    } catch {
      return null;
    }
  }

  async listLabels(prNumber: number): Promise<string[]> {
    const result = await exec("gh", [
      "pr", "view", String(prNumber),
      "--repo", this.repoFullName,
      "--json", "labels",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) return [];

    try {
      const data = JSON.parse(result.stdout) as {
        labels: Array<{ name: string }>;
      };
      return data.labels.map((l) => l.name);
    } catch {
      return [];
    }
  }
}

/** Map GitHub REST API check-run status/conclusion to our union. */
function mapRestConclusion(status: string | undefined, conclusion: string | null): CheckResult["conclusion"] {
  if (status !== "completed" || conclusion === null) return "pending";
  switch (conclusion) {
    case "success": case "neutral": case "skipped": return "success";
    case "failure": case "cancelled": case "timed_out":
    case "stale": case "action_required": return "failure";
    default: return "pending";
  }
}
