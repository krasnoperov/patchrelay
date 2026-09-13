import type { GitHubStatusRollupEntry } from "./github-rollup.ts";
import { execCommand } from "./utils.ts";

export type IntegrationCandidateState =
  | { kind: "absent"; branch: string }
  | { kind: "conflicted"; branch: string; candidateSha: string; approvedHeadSha: string }
  | { kind: "pending"; branch: string; candidateSha: string; approvedHeadSha: string; checks: GitHubStatusRollupEntry[] }
  | { kind: "green"; branch: string; candidateSha: string; approvedHeadSha: string; checks: GitHubStatusRollupEntry[] }
  | { kind: "failed"; branch: string; candidateSha: string; approvedHeadSha: string; checks: GitHubStatusRollupEntry[]; failedChecks: GitHubStatusRollupEntry[] };

const FAILED_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "stale",
  "startup_failure",
  "timed_out",
]);

export function integrationCandidateBranch(baseBranch: string, prNumber: number): string {
  return `merge-steward/${baseBranch}/pr-${prNumber}`;
}

/**
 * GitHub refs and ancestry are the integration-repair protocol. This reader is
 * deliberately stateless: callers may run it after any webhook, periodic
 * reconciliation, or process restart and derive the same action.
 */
export async function readIntegrationCandidateState(params: {
  repoFullName: string;
  baseBranch: string;
  prNumber: number;
  approvedHeadSha: string;
  requiredChecks: string[];
  runCommand?: typeof execCommand;
}): Promise<IntegrationCandidateState | undefined> {
  const runCommand = params.runCommand ?? execCommand;
  const branch = integrationCandidateBranch(params.baseBranch, params.prNumber);
  const ref = await runCommand("gh", [
    "api",
    `repos/${params.repoFullName}/git/ref/heads/${branch}`,
    "--jq",
    ".object.sha",
  ], { timeoutMs: 10_000 });
  if (ref.exitCode !== 0) {
    // A missing workspace means Merge Steward has not published a candidate;
    // it is not a request for PatchRelay work.
    if (/404|not found/i.test(`${ref.stdout}\n${ref.stderr}`)) {
      return { kind: "absent", branch };
    }
    return undefined;
  }

  const candidateSha = ref.stdout.trim();
  if (!candidateSha) return undefined;
  const comparison = await runCommand("gh", [
    "api",
    `repos/${params.repoFullName}/compare/${params.approvedHeadSha}...${candidateSha}`,
    "--jq",
    ".status",
  ], { timeoutMs: 10_000 });
  if (comparison.exitCode !== 0) return undefined;
  const containsApprovedHead = comparison.stdout.trim().toLowerCase() === "ahead"
    || comparison.stdout.trim().toLowerCase() === "identical";
  if (!containsApprovedHead) {
    return { kind: "conflicted", branch, candidateSha, approvedHeadSha: params.approvedHeadSha };
  }

  const checksResult = await runCommand("gh", [
    "api",
    `repos/${params.repoFullName}/commits/${candidateSha}/check-runs`,
    "--paginate",
    "--jq",
    ".check_runs[] | [.name, .status, (.conclusion // \"\"), (.details_url // \"\")] | @tsv",
  ], { timeoutMs: 10_000 });
  if (checksResult.exitCode !== 0) return undefined;
  const checks = parseCheckRuns(checksResult.stdout);
  const required = params.requiredChecks.map((name) => name.trim().toLowerCase()).filter(Boolean);
  const matching = checks.filter((check) => required.includes(check.name?.trim().toLowerCase() ?? ""));
  const failedChecks = matching.filter((check) => FAILED_CONCLUSIONS.has(check.conclusion?.toLowerCase() ?? ""));
  if (failedChecks.length > 0) {
    return { kind: "failed", branch, candidateSha, approvedHeadSha: params.approvedHeadSha, checks, failedChecks };
  }
  const allRequiredSucceeded = required.length > 0 && required.every((name) => matching.some((check) =>
    check.name?.trim().toLowerCase() === name
    && check.status?.toLowerCase() === "completed"
    && ["success", "neutral", "skipped"].includes(check.conclusion?.toLowerCase() ?? "")
  ));
  return allRequiredSucceeded
    ? { kind: "green", branch, candidateSha, approvedHeadSha: params.approvedHeadSha, checks }
    : { kind: "pending", branch, candidateSha, approvedHeadSha: params.approvedHeadSha, checks };
}

export function parseCheckRuns(stdout: string): GitHubStatusRollupEntry[] {
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, status, conclusion, detailsUrl] = line.split("\t");
    return {
      ...(name ? { name } : {}),
      ...(status ? { status } : {}),
      ...(conclusion ? { conclusion } : {}),
      ...(detailsUrl ? { detailsUrl } : {}),
    };
  });
}
