import type { ReviewEligibility, ReviewQuillRepositoryConfig } from "./types.ts";
import type { CheckRunRecord } from "./types.ts";

function normalizeCheckName(name: string): string {
  return name.trim().toLowerCase();
}

function branchExcluded(repo: ReviewQuillRepositoryConfig, branchName: string): boolean {
  return repo.excludeBranches.some((pattern) => pattern.endsWith("*")
    ? branchName.startsWith(pattern.slice(0, -1))
    : branchName === pattern);
}

function requiredChecksGreen(requiredChecks: string[], checks: CheckRunRecord[]): boolean {
  if (requiredChecks.length === 0) {
    return checks.length > 0
      && checks.every((check) => {
        const conclusion = (check.conclusion ?? "").toLowerCase();
        return check.status === "completed" && ["success", "neutral", "skipped"].includes(conclusion);
      });
  }
  return requiredChecks.every((required) => {
    const key = normalizeCheckName(required);
    const match = checks.find((check) => normalizeCheckName(check.name) === key);
    if (!match) {
      return false;
    }
    const conclusion = (match.conclusion ?? "").toLowerCase();
    return match.status === "completed" && ["success", "neutral", "skipped"].includes(conclusion);
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
  const checks = (await github.listCheckRuns(repo.repoFullName, headSha)).map((check, index) => ({
    ...check,
    id: index + 1,
  }));
  if (!repo.waitForGreenChecks) {
    return { eligible: true, checkRuns: checks };
  }
  if (!requiredChecksGreen(repo.requiredChecks, checks)) {
    return { eligible: false, reason: "required_checks_not_green", checkRuns: checks };
  }
  return { eligible: true, checkRuns: checks };
}
