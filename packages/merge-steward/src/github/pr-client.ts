import type { GitHubPRApi } from "../interfaces.ts";
import type { CheckResult, PRStatus } from "../types.ts";
import { mapGitHubCheckConclusion } from "../check-policy.ts";
import { exec } from "../exec.ts";

export function hasApprovalForHead(
  reviews: Array<{ state?: string; commit?: { oid?: string } }> | undefined,
  headSha: string,
): boolean {
  return (reviews ?? []).some((review) =>
    review.state === "APPROVED" && review.commit?.oid === headSha);
}

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
      // The base ref lets admission detect stacked PRs.
      "--json", "number,title,headRefName,headRefOid,baseRefName,reviewDecision,reviews,state,mergeStateStatus",
    ], { githubRepoFullName: this.repoFullName });

    const data = JSON.parse(result.stdout) as {
      number: number;
      title?: string;
      headRefName: string;
      headRefOid: string;
      baseRefName?: string;
      reviewDecision: string;
      reviews?: Array<{ state?: string; commit?: { oid?: string } }>;
      state: string;
      mergeStateStatus?: string;
    };

    return {
      number: data.number,
      branch: data.headRefName,
      headSha: data.headRefOid,
      ...(data.title ? { title: data.title } : {}),
      ...(data.baseRefName ? { baseRefName: data.baseRefName } : {}),
      mergeable: data.state === "OPEN",
      mergeStateStatus: data.mergeStateStatus,
      reviewDecision: data.reviewDecision,
      reviewApproved: data.reviewDecision === "APPROVED"
        && hasApprovalForHead(data.reviews, data.headRefOid),
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
        id?: number;
        name: string;
        status?: string;
        conclusion: string | null;
        html_url?: string;
        app?: { id?: number };
      }>;
      return checks
        .map((c) => ({
          name: c.name,
          conclusion: mapGitHubCheckConclusion(c.status, c.conclusion),
          ...(typeof c.app?.id === "number" ? { appId: c.app.id } : {}),
          ...(typeof c.id === "number" ? { runId: c.id } : {}),
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

  async listOpenPRs(): Promise<Array<{ number: number; branch: string; headSha: string; baseBranch: string }>> {
    const result = await exec("gh", [
      "pr", "list",
      "--repo", this.repoFullName,
      "--state", "open",
      "--json", "number,headRefName,headRefOid,baseRefName",
      "--limit", "1000",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list open PRs: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }

    try {
      const data = JSON.parse(result.stdout) as Array<{
        number: number;
        headRefName: string;
        headRefOid: string;
        baseRefName: string;
      }>;
      return data.map((pr) => ({
        number: pr.number,
        branch: pr.headRefName,
        headSha: pr.headRefOid,
        baseBranch: pr.baseRefName,
      }));
    } catch (error) {
      throw new Error("GitHub returned malformed open PR data", { cause: error });
    }
  }

  async listOpenPRsByBase(baseBranch: string): Promise<Array<{ number: number; branch: string; headSha: string; baseBranch: string }>> {
    const result = await exec("gh", [
      "api", "--method", "GET",
      `repos/${this.repoFullName}/pulls`,
      "-f", "state=open",
      "-f", `base=${baseBranch}`,
      "-f", "per_page=100",
      "--paginate", "--slurp",
    ], { githubRepoFullName: this.repoFullName });

    try {
      const pages = JSON.parse(result.stdout) as Array<Array<{
        number: number;
        head: { ref: string; sha: string };
        base: { ref: string };
      }>>;
      return pages.flat().map((pr) => ({
        number: pr.number,
        branch: pr.head.ref,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
      }));
    } catch (error) {
      throw new Error("GitHub returned malformed stack child PR data", { cause: error });
    }
  }

  async setBaseBranch(prNumber: number, baseBranch: string): Promise<void> {
    await exec("gh", [
      "api", "--method", "PATCH",
      `repos/${this.repoFullName}/pulls/${prNumber}`,
      "-f", `base=${baseBranch}`,
    ], { githubRepoFullName: this.repoFullName });
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
      "api",
      `repos/${this.repoFullName}/issues/${prNumber}/labels`,
      "--paginate",
      "--jq", ".[].name",
    ], { allowNonZero: true, githubRepoFullName: this.repoFullName });

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list labels for PR #${prNumber}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }

    return result.stdout.split(/\r?\n/).map((label) => label.trim()).filter(Boolean);
  }

  async setLabels(prNumber: number, opts: { add?: string[]; remove?: string[] }): Promise<void> {
    const args = ["pr", "edit", String(prNumber), "--repo", this.repoFullName];
    for (const label of opts.add ?? []) args.push("--add-label", label);
    for (const label of opts.remove ?? []) args.push("--remove-label", label);
    // Nothing to change beyond the base args — skip the call.
    if (args.length === 5) return;
    const result = await exec("gh", args, { allowNonZero: true, githubRepoFullName: this.repoFullName });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to edit labels for PR #${prNumber}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
  }
}

/** Map GitHub REST API check-run status/conclusion to our union. */
