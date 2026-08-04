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
 */
export async function findUnlandedOpenPrAncestors(params: {
  github: GitHubPRApi;
  git: GitOperations;
  currentPrNumber: number;
  prHeadSha: string;
  candidateSha: string;
  baseSha: string;
}): Promise<OpenPrAncestor[]> {
  const openPrs = await params.github.listOpenPRs();
  const blockers: OpenPrAncestor[] = [];

  for (const openPr of openPrs) {
    if (openPr.number === params.currentPrNumber) continue;
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
