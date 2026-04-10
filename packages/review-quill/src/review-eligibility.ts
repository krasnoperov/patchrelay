import type { ReviewEligibility, ReviewQuillRepositoryConfig } from "./types.ts";

function branchExcluded(repo: ReviewQuillRepositoryConfig, branchName: string): boolean {
  return repo.excludeBranches.some((pattern) => pattern.endsWith("*")
    ? branchName.startsWith(pattern.slice(0, -1))
    : branchName === pattern);
}

function requiredChecksGreen(requiredChecks: string[], checks: Array<{ name: string; status: string; conclusion?: string }>): boolean {
  if (requiredChecks.length === 0) {
    return checks.length > 0 && checks.every((check) => check.status === "completed" && ["success", "neutral", "skipped"].includes(check.conclusion ?? ""));
  }
  return requiredChecks.every((required) => {
    const match = checks.find((check) => check.name === required);
    return Boolean(match && match.status === "completed" && ["success", "neutral", "skipped"].includes(match.conclusion ?? ""));
  });
}

export async function evaluateReviewEligibility(params: {
  repo: ReviewQuillRepositoryConfig;
  github: {
    listCheckRuns(repoFullName: string, headSha: string): Promise<Array<{ name: string; status: string; conclusion?: string }>>;
  };
  headSha: string;
  isDraft: boolean;
  branchName: string;
}): Promise<ReviewEligibility> {
  const { repo, github, headSha, isDraft, branchName } = params;
  if (isDraft) return { eligible: false, reason: "draft" };
  if (!headSha) return { eligible: false, reason: "missing_head_sha" };
  if (branchExcluded(repo, branchName)) return { eligible: false, reason: "excluded_branch" };
  const checks = await github.listCheckRuns(repo.repoFullName, headSha);
  if (!requiredChecksGreen(repo.requiredChecks, checks)) {
    return { eligible: false, reason: "required_checks_not_green" };
  }
  return { eligible: true };
}
