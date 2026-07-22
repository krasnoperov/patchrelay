// Plan §8.2: detect when an outgoing PR would conflict with an
// already-in-flight PR and recommend stacking against it instead of
// opening against main. Pure logic — IO is injected via the
// `GitProbe` interface so tests can drive it deterministically and
// the CLI can wire it to `spawnSync` git invocations.

export interface SequenceCandidate {
  prNumber: number;
  branch: string;
  headSha: string;
  reviewState?: "approved" | "changes_requested" | "review_required" | string | undefined;
  checkStatus?: "success" | "failure" | "pending" | string | undefined;
  queueSignalled?: boolean | undefined;
  queueAgeMs?: number | undefined;
  labels?: string[] | undefined;
}

export interface SelfBranchInput {
  branch: string;
  headSha: string;
  baseRef: string;
}

export interface GitProbe {
  // Files changed between baseSha (merge-base or explicit base) and headSha.
  changedFiles(baseRef: string, headSha: string): Promise<string[]>;
  // True if `git merge-tree --write-tree --no-messages baseRef candidateHead`
  // exits non-zero (real conflict). False on clean merge.
  hasConflict(headSha: string, candidateHeadSha: string): Promise<boolean>;
}

export type SequenceRecommendationKind = "open_pr_against_main" | "rebase_onto";

export interface OpenPrAgainstMainResult {
  recommendation: "open_pr_against_main";
  reason: string;
}

export interface RebaseOntoResult {
  recommendation: "rebase_onto";
  parentPr: number;
  parentBranch: string;
  parentHead: string;
  reason: string;
  conflictingFiles: string[];
}

export type SequenceRecommendation = OpenPrAgainstMainResult | RebaseOntoResult;

export interface DetectStackingTargetParams {
  self: SelfBranchInput;
  candidates: SequenceCandidate[];
  git: GitProbe;
  // Per-PR labels indicating "do not stack onto me." Defaults to
  // `wip`, `do-not-merge`, `do-not-merge-before`. Lowercased compare.
  skipLabels?: string[];
}

const DEFAULT_SKIP_LABELS = ["wip", "do-not-merge", "do-not-merge-before"];

export async function detectStackingTarget(
  params: DetectStackingTargetParams,
): Promise<SequenceRecommendation> {
  const { self, candidates, git } = params;
  const skipLabels = (params.skipLabels ?? DEFAULT_SKIP_LABELS).map((label) =>
    label.trim().toLowerCase(),
  );

  if (candidates.length === 0) {
    return { recommendation: "open_pr_against_main", reason: "no in-flight PRs to stack on" };
  }

  // Step 1: file-overlap pre-filter. Compute self's changed files
  // once, then keep candidates whose changed-file set intersects.
  const ownFiles = new Set(await git.changedFiles(self.baseRef, self.headSha));
  if (ownFiles.size === 0) {
    return { recommendation: "open_pr_against_main", reason: "no files changed in current branch" };
  }

  const overlappingCandidates: Array<{
    candidate: SequenceCandidate;
    overlap: string[];
  }> = [];

  for (const candidate of candidates) {
    if (candidate.branch === self.branch || candidate.headSha === self.headSha) continue;
    if (hasSkipLabel(candidate, skipLabels)) continue;
    let candidateFiles: string[];
    try {
      candidateFiles = await git.changedFiles(self.baseRef, candidate.headSha);
    } catch {
      continue;
    }
    const overlap = candidateFiles.filter((file) => ownFiles.has(file));
    if (overlap.length > 0) {
      overlappingCandidates.push({ candidate, overlap });
    }
  }

  if (overlappingCandidates.length === 0) {
    return {
      recommendation: "open_pr_against_main",
      reason: "no overlapping in-flight PRs",
    };
  }

  // Step 2: real conflict probe via merge-tree on each surviving
  // candidate. We score only those that actually conflict; trees
  // that auto-merge (different lines of the same file) are skipped.
  const conflicting: Array<{
    candidate: SequenceCandidate;
    overlap: string[];
  }> = [];
  for (const entry of overlappingCandidates) {
    let conflict = false;
    try {
      conflict = await git.hasConflict(self.headSha, entry.candidate.headSha);
    } catch {
      // Treat probe failure as "no conflict known" — fall through to
      // open against main rather than recommending a possibly wrong
      // stack target.
      continue;
    }
    if (conflict) {
      conflicting.push(entry);
    }
  }

  if (conflicting.length === 0) {
    return {
      recommendation: "open_pr_against_main",
      reason: "overlapping files but no real conflict on merge-tree probe",
    };
  }

  // Step 3: score by likelihood-to-land-first. Higher score wins.
  const ranked = conflicting
    .map((entry) => ({ ...entry, score: scoreCandidate(entry.candidate) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie: prefer older queue entry.
      const ageA = a.candidate.queueAgeMs ?? 0;
      const ageB = b.candidate.queueAgeMs ?? 0;
      if (ageA !== ageB) return ageB - ageA;
      // Final tie: lowest PR number first (it was opened earlier).
      return a.candidate.prNumber - b.candidate.prNumber;
    });

  const winner = ranked[0]!;
  const reasonBits: string[] = [];
  reasonBits.push(`conflict on ${formatFileList(winner.overlap)}`);
  reasonBits.push(`PR #${winner.candidate.prNumber} ${describeReadiness(winner.candidate)}`);
  return {
    recommendation: "rebase_onto",
    parentPr: winner.candidate.prNumber,
    parentBranch: winner.candidate.branch,
    parentHead: winner.candidate.headSha,
    reason: reasonBits.join("; ") + ", expected to land first",
    conflictingFiles: winner.overlap,
  };
}

function scoreCandidate(candidate: SequenceCandidate): number {
  const review = (candidate.reviewState ?? "").trim().toLowerCase();
  const checks = (candidate.checkStatus ?? "").trim().toLowerCase();
  let score = 0;
  // Already in the queue → most likely to land first.
  if (candidate.queueSignalled) score += 100;
  if (review === "approved") score += 50;
  if (checks === "success" || checks === "passed") score += 25;
  if (review === "changes_requested") score -= 30;
  return score;
}

function hasSkipLabel(candidate: SequenceCandidate, skipLabels: string[]): boolean {
  const labels = (candidate.labels ?? []).map((label) => label.trim().toLowerCase());
  return labels.some((label) => skipLabels.includes(label));
}

function describeReadiness(candidate: SequenceCandidate): string {
  const review = (candidate.reviewState ?? "").trim().toLowerCase();
  const checks = (candidate.checkStatus ?? "").trim().toLowerCase();
  if (candidate.queueSignalled) return "is in the merge queue";
  if (review === "approved" && (checks === "success" || checks === "passed")) {
    return "is approved + green";
  }
  if (review === "approved") return "is approved";
  return "is in flight";
}

function formatFileList(files: string[]): string {
  if (files.length <= 3) return files.join(", ");
  return `${files.slice(0, 3).join(", ")} (+${files.length - 3} more)`;
}
