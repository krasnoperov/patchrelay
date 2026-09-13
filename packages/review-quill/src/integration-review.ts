import type { Logger } from "pino";
import type { GitHubClient } from "./github-client.ts";
import type {
  CheckRunRecord,
  GitHubCommitRecord,
  GitHubRefRecord,
  PullRequestReviewRecord,
  PullRequestSummary,
  ReviewContext,
  ReviewQuillRepositoryConfig,
} from "./types.ts";
import type { ReviewRunner } from "./review-runner.ts";
import { buildReviewContext } from "./review-context.ts";
import { materializeIntegrationWorkspace } from "./review-workspace/index.ts";
import { alignFindingAnchors } from "./finding-anchors.ts";

export const INTEGRATION_CHECK_NAME = "review-quill/integration";

export interface IntegrationCandidateRef {
  ref: string;
  baseBranch: string;
  prNumber: number;
  candidateSha: string;
}

export interface IntegrationReviewCandidate extends IntegrationCandidateRef {
  approvedHeadSha: string;
  prospectiveBaseSha: string;
}

function normalizedAppLogin(login: string | undefined): string | undefined {
  return login?.trim().toLowerCase().replace(/\[bot\]$/, "");
}

export function parseIntegrationCandidateRef(ref: GitHubRefRecord): IntegrationCandidateRef | undefined {
  const match = /^refs\/heads\/merge-steward\/(.+)\/pr-(\d+)$/.exec(ref.ref);
  if (!match?.[1] || !match[2]) return undefined;
  const prNumber = Number(match[2]);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return undefined;
  return { ref: ref.ref, baseBranch: match[1], prNumber, candidateSha: ref.sha };
}

export function integrationCandidateMatchesPullRequest(
  candidate: IntegrationCandidateRef,
  pr: PullRequestSummary,
  repositoryBaseBranch: string,
): boolean {
  return candidate.prNumber === pr.number && candidate.baseBranch === repositoryBaseBranch;
}

export function findFrozenApprovedHead(
  reviews: PullRequestReviewRecord[],
  currentHeadSha: string,
): string | undefined {
  return reviews.some((review) =>
    review.state === "APPROVED" && review.commitId === currentHeadSha
  ) ? currentHeadSha : undefined;
}

export function hasIntegrationCheck(checks: CheckRunRecord[]): boolean {
  return checks.some((check) => check.name === INTEGRATION_CHECK_NAME && (
    check.status !== "completed" || check.conclusion === "success" || check.conclusion === "failure"
  ));
}

export function isPatchRelayCommit(commit: GitHubCommitRecord): boolean {
  return [commit.authorLogin, commit.committerLogin]
    .map(normalizedAppLogin)
    .some((login) => login === "patchrelay");
}

async function findProspectiveBaseSha(
  github: Pick<GitHubClient, "getCommit">,
  repoFullName: string,
  tip: GitHubCommitRecord,
  approvedHeadSha: string,
): Promise<string | undefined> {
  let current = tip;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32 && !visited.has(current.sha); depth += 1) {
    visited.add(current.sha);
    if (current.parentShas.includes(approvedHeadSha)) {
      return current.parentShas.find((sha) => sha !== approvedHeadSha);
    }
    const firstParent = current.parentShas[0];
    if (!firstParent) return undefined;
    current = await github.getCommit(repoFullName, firstParent);
  }
  return undefined;
}

export async function selectIntegrationReviewCandidate(params: {
  github: Pick<GitHubClient, "listPullRequestReviews" | "listCheckRuns" | "getCommit" | "isAncestor">;
  repoFullName: string;
  pr: PullRequestSummary;
  candidate: IntegrationCandidateRef;
  reviewerLogin?: string;
}): Promise<IntegrationReviewCandidate | undefined> {
  if (params.pr.state !== "OPEN" || params.pr.isDraft) return undefined;
  const reviews = await params.github.listPullRequestReviews(params.repoFullName, params.pr.number);
  // Merge Steward already enforces the repository's aggregate approval rule.
  // Integration preservation may therefore bind to any still-effective
  // approval on the exact feature head, including a human approval.
  const approvedHeadSha = findFrozenApprovedHead(reviews, params.pr.headSha);
  if (!approvedHeadSha) return undefined;
  if (!await params.github.isAncestor(params.repoFullName, approvedHeadSha, params.candidate.candidateSha)) return undefined;
  const checks = await params.github.listCheckRuns(params.repoFullName, params.candidate.candidateSha);
  if (hasIntegrationCheck(checks)) return undefined;
  const tip = await params.github.getCommit(params.repoFullName, params.candidate.candidateSha);
  if (!isPatchRelayCommit(tip)) return undefined;
  const prospectiveBaseSha = await findProspectiveBaseSha(
    params.github,
    params.repoFullName,
    tip,
    approvedHeadSha,
  );
  if (!prospectiveBaseSha) return undefined;
  return { ...params.candidate, approvedHeadSha, prospectiveBaseSha };
}

function integrationPrompt(candidate: IntegrationReviewCandidate, pr: PullRequestSummary): string {
  return [
    "You are Review Quill performing a narrow integration-preservation review.",
    "This is not a new feature review. The feature was already approved; do not relitigate unchanged feature design.",
    "Decide only whether PatchRelay's integration repair preserved the approved feature's behavior and contract while composing it with the prospective base.",
    "",
    `Pull request: #${pr.number} — ${pr.title}`,
    `Approved feature head: ${candidate.approvedHeadSha}`,
    `Prospective base: ${candidate.prospectiveBaseSha}`,
    `Candidate: ${candidate.candidateSha}`,
    `Candidate ref: ${candidate.ref}`,
    "",
    "Inspect the checkout and use these immutable comparisons:",
    `- git diff ${candidate.prospectiveBaseSha}..${candidate.candidateSha} --`,
    `- git diff ${candidate.approvedHeadSha}..${candidate.candidateSha} --`,
    `- git range-diff $(git merge-base ${candidate.prospectiveBaseSha} ${candidate.approvedHeadSha})..${candidate.approvedHeadSha} ${candidate.prospectiveBaseSha}..${candidate.candidateSha} --`,
    "",
    "Request changes only when the integration repair materially changes feature acceptance criteria, public API, schema, security, billing, persistence, permissions, error behavior, or feature-owned test expectations.",
    "Conflict composition, imports adapted to the new base, canonical generated files, and test repairs that preserve approved behavior are allowed.",
    "Every blocking finding must be caused by the integration repair and anchored to a changed candidate line. Ignore unrelated pre-existing issues.",
    "Return the normal Review Quill JSON verdict only. An approve means integration preserved the feature; request_changes means the feature materially changed.",
  ].join("\n");
}

export async function executeIntegrationReview(params: {
  github: GitHubClient;
  runner: ReviewRunner;
  logger: Logger;
  repo: ReviewQuillRepositoryConfig;
  pr: PullRequestSummary;
  candidate: IntegrationReviewCandidate;
  prompting: ReviewContext["promptCustomization"];
  reviewerLogin?: string;
}): Promise<void> {
  const token = params.github.currentTokenForRepo(params.repo.repoFullName);
  if (!token) throw new Error(`No GitHub installation token available for ${params.repo.repoFullName}`);
  const checkId = await params.github.createCheckRun(params.repo.repoFullName, {
    name: INTEGRATION_CHECK_NAME,
    headSha: params.candidate.candidateSha,
    status: "in_progress",
    title: "Reviewing integration repair",
    summary: `Checking whether PR #${params.pr.number}'s approved feature was preserved.`,
  });
  try {
    const materialized = await materializeIntegrationWorkspace({
      repoFullName: params.repo.repoFullName,
      candidateRef: params.candidate.ref,
      candidateSha: params.candidate.candidateSha,
      approvedHeadSha: params.candidate.approvedHeadSha,
      prospectiveBaseSha: params.candidate.prospectiveBaseSha,
      prNumber: params.pr.number,
      token,
    });
    const syntheticPr: PullRequestSummary = {
      ...params.pr,
      headSha: params.candidate.candidateSha,
      headRefName: params.candidate.ref.replace(/^refs\/heads\//, ""),
      baseRefName: params.candidate.baseBranch,
      baseSha: params.candidate.prospectiveBaseSha,
    };
    const prepared = await buildReviewContext({
      github: params.github,
      repo: params.repo,
      pr: syntheticPr,
      prompting: params.prompting,
      logger: params.logger,
      selfLogin: params.reviewerLogin,
      materialized,
    });
    try {
      const prompt = integrationPrompt(params.candidate, params.pr);
      const {
        followUpPrompt: _followUpPrompt,
        nativeFollowUpReviewPrompt: _nativeFollowUpReviewPrompt,
        ...baseContext
      } = prepared.context;
      const context: ReviewContext = {
        ...baseContext,
        prompt,
        nativeReviewPrompt: prompt,
        developerInstructions: prompt,
      };
      const reviewed = await params.runner.review(context);
      const verdict = await alignFindingAnchors(context.workspace, reviewed.verdict);
      const success = verdict.verdict === "approve";
      const findings = verdict.findings.map((finding) => `${finding.path}:${finding.line} — ${finding.message}`).join("\n");
      await params.github.updateCheckRun(params.repo.repoFullName, checkId, {
        status: "completed",
        conclusion: success ? "success" : "failure",
        title: success ? "Integration preserved approved feature" : "Integration changed approved feature",
        summary: verdict.verdict_reason,
        text: findings || verdict.walkthrough || verdict.verdict_reason,
      });
    } finally {
      await prepared.dispose();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await params.github.updateCheckRun(params.repo.repoFullName, checkId, {
      status: "completed",
      conclusion: "neutral",
      title: "Integration review could not complete",
      summary: message,
      text: message,
    }).catch(() => undefined);
    throw error;
  }
}
