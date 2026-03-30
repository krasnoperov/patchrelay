import type { GitHubPRApi } from "../interfaces.ts";
import type { CheckResult, PRStatus } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * GitHub PR operations via gh CLI and REST API.
 *
 * Two external contracts:
 *  - gh pr checks: uses `bucket` (pass/fail/pending/skipping) for classification.
 *  - REST check-runs API: uses lowercase `conclusion` (success/failure/cancelled/…).
 *
 * Both map to the internal CheckConclusion union: success | failure | pending.
 */
export class GitHubPRClient implements GitHubPRApi {
  constructor(private readonly repoFullName: string) {}

  async mergePR(prNumber: number): Promise<void> {
    await exec("gh", [
      "pr", "merge", String(prNumber),
      "--repo", this.repoFullName,
      "--merge", "--delete-branch",
    ], { timeoutMs: 60_000 });
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
      "--json", "name,bucket,link",
    ], { allowNonZero: true });

    if (result.exitCode !== 0) return [];

    try {
      const checks = JSON.parse(result.stdout) as Array<{
        name: string;
        bucket: string;
        link?: string;
      }>;

      return checks.map((c) => ({
        name: c.name,
        conclusion: mapBucket(c.bucket),
        url: c.link,
      }));
    } catch {
      return [];
    }
  }

  async listChecksForRef(ref: string): Promise<CheckResult[]> {
    // Callers pass remote-tracking refs like "origin/main"; the API needs "main" or a SHA.
    const apiRef = ref.replace(/^origin\//, "");
    const result = await exec("gh", [
      "api",
      `repos/${this.repoFullName}/commits/${apiRef}/check-runs`,
      "--jq", ".check_runs",
    ], { allowNonZero: true });

    if (result.exitCode !== 0) return [];

    try {
      const checks = JSON.parse(result.stdout) as Array<{
        name: string;
        conclusion: string | null;
      }>;
      return checks
        .filter((c) => c.conclusion !== null)
        .map((c) => ({
          name: c.name,
          conclusion: mapRestConclusion(c.conclusion!),
        }));
    } catch {
      return [];
    }
  }

  async findPRByBranch(branch: string): Promise<number | null> {
    const result = await exec("gh", [
      "pr", "list",
      "--repo", this.repoFullName,
      "--head", branch,
      "--state", "open",
      "--json", "number",
      "--limit", "1",
    ], { allowNonZero: true });

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
    ], { allowNonZero: true });

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

/** Map gh pr checks bucket field (pass/fail/pending/skipping) to our union. */
function mapBucket(bucket: string): CheckResult["conclusion"] {
  switch (bucket) {
    case "pass": return "success";
    case "fail": return "failure";
    default: return "pending";
  }
}

/** Map GitHub REST API check-run conclusion (lowercase) to our union. */
function mapRestConclusion(conclusion: string): CheckResult["conclusion"] {
  switch (conclusion) {
    case "success": case "neutral": case "skipped": return "success";
    case "failure": case "cancelled": case "timed_out":
    case "stale": case "action_required": return "failure";
    default: return "pending";
  }
}
