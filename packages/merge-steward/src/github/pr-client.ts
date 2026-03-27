import type { GitHubPRApi } from "../interfaces.ts";
import type { CheckResult, PRStatus } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * GitHub PR operations via gh CLI.
 */
export class GitHubPRClient implements GitHubPRApi {
  constructor(private readonly repoFullName: string) {}

  async mergePR(prNumber: number, method: "squash" | "merge"): Promise<void> {
    const args = ["pr", "merge", String(prNumber), "--repo", this.repoFullName];
    if (method === "squash") args.push("--squash");
    else args.push("--merge");
    args.push("--delete-branch");
    await exec("gh", args, { timeoutMs: 60_000 });
  }

  async getStatus(prNumber: number): Promise<PRStatus> {
    const result = await exec("gh", [
      "pr", "view", String(prNumber),
      "--repo", this.repoFullName,
      "--json", "number,headRefName,headRefOid,reviewDecision,state",
    ]);

    const data = JSON.parse(result.stdout) as {
      number: number;
      headRefName: string;
      headRefOid: string;
      reviewDecision: string;
      state: string;
    };

    return {
      number: data.number,
      branch: data.headRefName,
      headSha: data.headRefOid,
      mergeable: data.state === "OPEN",
      reviewApproved: data.reviewDecision === "APPROVED",
      merged: data.state === "MERGED",
    };
  }

  async listChecks(prNumber: number): Promise<CheckResult[]> {
    const result = await exec("gh", [
      "pr", "checks", String(prNumber),
      "--repo", this.repoFullName,
      "--json", "name,conclusion,detailsUrl",
    ], { allowNonZero: true });

    if (result.exitCode !== 0) return [];

    try {
      const checks = JSON.parse(result.stdout) as Array<{
        name: string;
        conclusion: string;
        detailsUrl?: string;
      }>;

      return checks.map((c) => ({
        name: c.name,
        conclusion: mapConclusion(c.conclusion),
        url: c.detailsUrl,
      }));
    } catch {
      return [];
    }
  }
}

function mapConclusion(gh: string): CheckResult["conclusion"] {
  switch (gh) {
    case "SUCCESS": return "success";
    case "FAILURE": return "failure";
    case "TIMED_OUT": return "timed_out";
    case "CANCELLED": return "cancelled";
    default: return "pending";
  }
}
