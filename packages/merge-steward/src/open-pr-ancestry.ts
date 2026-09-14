import type { GitHubPRApi, GitOperations } from "./interfaces.ts";

export interface OpenPrAncestor {
  prNumber: number;
  branch: string;
  headSha: string;
  sharedAncestorSha: string;
}

/**
 * Find ancestry shared with open PRs outside the current base.
 *
 * Testing only the other PR's current head is insufficient: a parent may have
 * advanced after the child copied its earlier blocked head. The merge base
 * captures that shared history. If it is absent from current main, landing the
 * candidate can bypass the other PR's review gates. Explicit stacks become
 * valid only after their shared parent history has landed in main.
 *
 * The danger is one-directional. A stack child's candidate carries its
 * parent's commits, which GitHub reviewed against the parent's branch rather
 * than against main, so the child must wait. A parent's candidate carries only
 * its own commits: the history it shares with its child is the parent's own,
 * it is in the parent's diff, and it was reviewed there. So a child never
 * blocks its parent, and saying so takes the declared base — after the parent
 * advances past the commit the child sits on, ancestry alone can no longer
 * tell a stack child from an unrelated PR holding the same unlanded history.
 */
export async function findUnlandedOpenPrAncestors(params: {
  github: GitHubPRApi;
  git: GitOperations;
  currentPrNumber: number;
  currentBranch: string;
  prHeadSha: string;
  candidateSha: string;
  baseSha: string;
}): Promise<OpenPrAncestor[]> {
  const openPrs = await params.github.listOpenPRs();
  const blockers: OpenPrAncestor[] = [];

  for (const openPr of openPrs) {
    if (openPr.number === params.currentPrNumber) continue;
    // Declared onto this PR's branch: a child, whatever its head has done since.
    // Both names must be present: a missing base must never read as a match,
    // or an API that stopped returning one would disable this check in silence.
    if (params.currentBranch !== "" && openPr.baseBranch === params.currentBranch) continue;
    if (
      openPr.headSha !== params.prHeadSha
      && await params.git.isAncestor(params.prHeadSha, openPr.headSha)
    ) continue;
    const sharedAncestorSha = await params.git.mergeBase(openPr.headSha, params.candidateSha);
    if (await params.git.isAncestor(sharedAncestorSha, params.baseSha)) continue;
    blockers.push({
      prNumber: openPr.number,
      branch: openPr.branch,
      headSha: openPr.headSha,
      sharedAncestorSha,
    });
  }

  return blockers;
}

export function describeOpenPrAncestors(blockers: OpenPrAncestor[]): string {
  return `candidate shares unlanded history with open PR ${blockers.map((blocker) => `#${blocker.prNumber} (${blocker.sharedAncestorSha.slice(0, 12)})`).join(", ")}`;
}
