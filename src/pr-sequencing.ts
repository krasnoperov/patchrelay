/**
 * Guard outgoing issue branches against silently carrying another open PR.
 *
 * PatchRelay issues are independent delivery units. Conflict prediction is not
 * a reason to rewrite that topology: an open PR can change, lose approval, or
 * fail review after a child branch has copied its commits. The only safe local
 * sequencing decision is therefore to keep the issue branch rooted on the
 * repository base and let the merge queue resolve ordering after either PR
 * changes main.
 */

export interface SequenceCandidate {
  prNumber: number;
  branch: string;
  headSha: string;
}

export interface SelfBranchInput {
  branch: string;
  headSha: string;
  baseRef: string;
}

export interface GitProbe {
  mergeBase(leftSha: string, rightSha: string): Promise<string>;
  isAncestor(ancestorSha: string, descendantSha: string): Promise<boolean>;
}

export interface OpenPrAgainstMainResult {
  recommendation: "open_pr_against_main";
  reason: string;
}

export interface BlockedOpenPrAncestryResult {
  recommendation: "blocked_open_pr_ancestry";
  reason: string;
  blockingPrs: Array<{
    prNumber: number;
    branch: string;
    headSha: string;
    sharedAncestorSha: string;
  }>;
}

export type SequenceRecommendation = OpenPrAgainstMainResult | BlockedOpenPrAncestryResult;

export async function detectStackingTarget(params: {
  self: SelfBranchInput;
  candidates: SequenceCandidate[];
  git: GitProbe;
}): Promise<SequenceRecommendation> {
  const blockingPrs: BlockedOpenPrAncestryResult["blockingPrs"] = [];

  for (const candidate of params.candidates) {
    if (candidate.branch === params.self.branch) continue;
    if (
      candidate.headSha !== params.self.headSha
      && await params.git.isAncestor(params.self.headSha, candidate.headSha)
    ) continue;
    const sharedAncestorSha = await params.git.mergeBase(candidate.headSha, params.self.headSha);
    if (!await params.git.isAncestor(sharedAncestorSha, params.self.baseRef)) {
      blockingPrs.push({
        prNumber: candidate.prNumber,
        branch: candidate.branch,
        headSha: candidate.headSha,
        sharedAncestorSha,
      });
    }
  }

  if (blockingPrs.length > 0) {
    const numbers = blockingPrs.map((candidate) => `#${candidate.prNumber}`).join(", ");
    return {
      recommendation: "blocked_open_pr_ancestry",
      reason: `current branch shares commits outside ${params.self.baseRef} with open PR ${numbers}; rebuild the issue's own commits on ${params.self.baseRef} before publishing`,
      blockingPrs,
    };
  }

  return {
    recommendation: "open_pr_against_main",
    reason: `all history shared with other open PRs is already present in ${params.self.baseRef}`,
  };
}
