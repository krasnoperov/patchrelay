import {
  gitDiffNameStatus,
  gitDiffNumstat,
  gitDiffPatch,
} from "../review-workspace/git.ts";
import { classifyDiffFile } from "./file-classifier.ts";
import { estimateTokens, PATCH_FRAMING_OVERHEAD_TOKENS } from "./tokens.ts";
import type {
  DiffFileInventoryEntry,
  DiffFilePatchEntry,
  DiffSuppressedEntry,
  ReviewDiffContext,
  ReviewQuillRepositoryConfig,
  ReviewWorkspace,
} from "../types.ts";

// The patch budget is a soft target, not a hard ceiling. When the packer
// is about to drop a useful file over a few tokens of overage, it's
// better to go slightly over budget than to lose the file. `SLACK_RATIO`
// is the amount of overage we'll accept — 10% gives ~2kT of wiggle room
// on a 20k budget, enough to keep a couple more small files without
// straying far from the target.
export const PACKER_SLACK_RATIO = 0.10;

export interface CandidatePatch {
  entry: DiffFileInventoryEntry;
  patch: string;
  tokens: number;
}

interface DemotedPatch {
  entry: DiffFileInventoryEntry;
  reason: string;
}

interface FetchedPatches {
  candidates: CandidatePatch[];
  demoted: DemotedPatch[];
}

function hasAnyHunk(patch: string): boolean {
  return patch.split("\n").some((line) => line.startsWith("@@"));
}

function parseNameStatusLine(line: string): { status: string; path: string; previousPath?: string } | undefined {
  if (!line.trim()) return undefined;
  const parts = line.split("\t");
  const rawStatus = parts[0]?.trim();
  if (!rawStatus) return undefined;
  if (rawStatus.startsWith("R") || rawStatus.startsWith("C")) {
    const previousPath = parts[1]?.trim();
    const nextPath = parts[2]?.trim();
    if (!previousPath || !nextPath) return undefined;
    return { status: rawStatus[0] ?? rawStatus, path: nextPath, previousPath };
  }
  const filePath = parts[1]?.trim();
  if (!filePath) return undefined;
  return { status: rawStatus[0] ?? rawStatus, path: filePath };
}

async function statFile(workspace: ReviewWorkspace, baseRef: string, filePath: string): Promise<{
  additions: number;
  deletions: number;
  changes: number;
  isBinary: boolean;
}> {
  const diffTarget = workspace.diffTarget ?? "head";
  const raw = (await gitDiffNumstat(workspace.worktreePath, baseRef, filePath, diffTarget)).trim();
  const line = raw.split(/\r?\n/).find(Boolean);
  if (!line) {
    return { additions: 0, deletions: 0, changes: 0, isBinary: false };
  }
  const [additionsRaw, deletionsRaw] = line.split("\t");
  const isBinary = additionsRaw === "-" || deletionsRaw === "-";
  const additions = isBinary ? 0 : Number(additionsRaw ?? 0);
  const deletions = isBinary ? 0 : Number(deletionsRaw ?? 0);
  return { additions, deletions, changes: additions + deletions, isBinary };
}

// Strip hunks that delete lines without adding any. Pure-deletion hunks rarely
// help a reviewer (the removed code is already gone; context lines in
// neighboring hunks show what's left) and they're the first thing PR-Agent
// drops during compression. A hunk is pure-deletion iff it has at least one
// `-` body line and zero `+` body lines. Empty-body hunks (rename markers
// with no content changes) survive so rename metadata isn't lost.
function stripDeletionOnlyHunks(patch: string): string {
  const lines = patch.split("\n");
  // Find the last line of the file-header block (before the first `@@`).
  let firstHunkIndex = lines.findIndex((line) => line.startsWith("@@"));
  if (firstHunkIndex < 0) return patch; // no hunks, return as-is

  const header = lines.slice(0, firstHunkIndex);
  const hunks: string[][] = [];
  let current: string[] = [];
  for (let i = firstHunkIndex; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith("@@")) {
      if (current.length > 0) hunks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) hunks.push(current);

  const keptHunks = hunks.filter((hunk) => {
    let hasAddition = false;
    let hasDeletion = false;
    for (let i = 1; i < hunk.length; i += 1) {
      const line = hunk[i]!;
      if (line.startsWith("+") && !line.startsWith("+++")) hasAddition = true;
      else if (line.startsWith("-") && !line.startsWith("---")) hasDeletion = true;
    }
    // Keep if: at least one addition (normal hunk), OR no deletions at all
    // (empty-body rename hunk). Drop only if: deletions without additions.
    return hasAddition || !hasDeletion;
  });

  if (keptHunks.length === hunks.length) return patch;
  if (keptHunks.length === 0) return header.join("\n");
  return [...header, ...keptHunks.flatMap((hunk) => hunk)].join("\n");
}

// Pass 1: enumerate all changed files and classify them by pattern only.
// No patch fetching here — this stays cheap for large PRs where most files
// end up in `ignore`.
async function collectInventory(
  repo: ReviewQuillRepositoryConfig,
  workspace: ReviewWorkspace,
): Promise<DiffFileInventoryEntry[]> {
  const baseRef = workspace.diffBaseRef ?? workspace.baseRef;
  const diffTarget = workspace.diffTarget ?? "head";
  const nameStatus = await gitDiffNameStatus(workspace.worktreePath, baseRef, diffTarget);
  const inventory: DiffFileInventoryEntry[] = [];

  for (const line of nameStatus.split(/\r?\n/)) {
    const parsed = parseNameStatusLine(line);
    if (!parsed) continue;
    const stats = await statFile(workspace, baseRef, parsed.path);
    const provisional = {
      path: parsed.path,
      ...(parsed.previousPath ? { previousPath: parsed.previousPath } : {}),
      status: parsed.status,
      additions: stats.additions,
      deletions: stats.deletions,
      changes: stats.changes,
      isBinary: stats.isBinary,
    };
    const classification = classifyDiffFile(repo, provisional);
    inventory.push({
      ...provisional,
      classification: classification.classification,
      ...(classification.reason ? { reason: classification.reason } : {}),
    });
  }

  return inventory;
}

// Pass 2: fetch the actual patch for every file the classifier marked
// eligible, strip deletion-only hunks, and estimate the token cost of
// each patch plus per-file framing. Files whose patches are empty after
// the deletion-only strip (pure-deletion files — the whole diff was
// just removed lines) are demoted to `suppressed` with reason
// `"no_additions"` so they don't crowd out useful files and don't show
// up as empty `\`\`\`diff ... \`\`\`` blocks in the rendered prompt.
async function fetchCandidatePatches(
  workspace: ReviewWorkspace,
  eligible: DiffFileInventoryEntry[],
): Promise<FetchedPatches> {
  const candidates: CandidatePatch[] = [];
  const demoted: DemotedPatch[] = [];
  const baseRef = workspace.diffBaseRef ?? workspace.baseRef;
  const diffTarget = workspace.diffTarget ?? "head";
  for (const entry of eligible) {
    const raw = await gitDiffPatch(workspace.worktreePath, baseRef, entry.path, diffTarget);
    const patch = stripDeletionOnlyHunks(raw);
    if (!hasAnyHunk(patch)) {
      demoted.push({ entry, reason: "no_additions" });
      continue;
    }
    const tokens = estimateTokens(patch) + PATCH_FRAMING_OVERHEAD_TOKENS;
    candidates.push({ entry, patch, tokens });
  }
  return { candidates, demoted };
}

// Pass 3: greedily pack candidates into the token budget. Sort by token
// count *ascending* so every small file is considered first. This
// deliberately prefers breadth over depth: a PR with one giant cli.ts
// (12k tokens) and 80 glue files (50 tokens each) fits all 80 glue files
// and drops cli.ts, rather than fitting cli.ts alone and starving the
// rest. The reviewer can always open large dropped files directly from
// the worktree — but files that don't appear in the inventory-patches
// section are effectively invisible.
//
// The budget is a soft target: the packer allows up to `PACKER_SLACK_RATIO`
// overage (10% by default) so a useful file doesn't get dropped over a few
// tokens. When a candidate doesn't fit *even with slack*, it goes to the
// overflow list with reason=`budget_exceeded`. No clipping is attempted
// in v1 — clipping a unified diff at arbitrary boundaries produces
// invalid patch text, and drop-to-summarize is a simpler, safer fallback.
export function packPatches(
  candidates: CandidatePatch[],
  budgetTokens: number,
): { patches: DiffFilePatchEntry[]; overflowed: DiffSuppressedEntry[] } {
  const effectiveBudget = budgetTokens + Math.floor(budgetTokens * PACKER_SLACK_RATIO);
  const sorted = [...candidates].sort((left, right) => left.tokens - right.tokens);
  const patches: DiffFilePatchEntry[] = [];
  const overflowed: DiffSuppressedEntry[] = [];
  let remaining = effectiveBudget;

  for (const candidate of sorted) {
    if (candidate.tokens <= remaining) {
      patches.push({
        ...candidate.entry,
        classification: "full_patch",
        patch: candidate.patch,
      });
      remaining -= candidate.tokens;
    } else {
      overflowed.push({
        ...candidate.entry,
        classification: "summarize",
        reason: "budget_exceeded",
      });
    }
  }

  return { patches, overflowed };
}

export async function buildDiffContext(
  repo: ReviewQuillRepositoryConfig,
  workspace: ReviewWorkspace,
): Promise<ReviewDiffContext> {
  const provisional = await collectInventory(repo, workspace);
  const eligible = provisional.filter((entry) => entry.classification === "full_patch");
  const { candidates, demoted } = await fetchCandidatePatches(workspace, eligible);
  const { patches, overflowed } = packPatches(candidates, repo.patchBodyBudgetTokens);

  // Final inventory must reflect each file's *final* classification. A file
  // that was provisionally "full_patch" may end up as "summarize" because:
  //   - the packer couldn't fit it (reason=budget_exceeded), or
  //   - its patch was empty after stripping deletion-only hunks
  //     (reason=no_additions — pure-deletion files)
  // Both cases land in the suppressed list so the rendered prompt shows
  // them with a one-line summary instead of an empty diff block.
  const demotionReasons = new Map<string, string>();
  for (const entry of overflowed) demotionReasons.set(entry.path, "budget_exceeded");
  for (const entry of demoted) demotionReasons.set(entry.entry.path, entry.reason);

  const inventory: DiffFileInventoryEntry[] = provisional.map((entry) => {
    const reason = demotionReasons.get(entry.path);
    if (reason) {
      return { ...entry, classification: "summarize", reason };
    }
    return entry;
  });

  // Suppressed list = all files whose *final* classification isn't "full_patch".
  // This includes ignored files, summarize-only files, binary files,
  // budget-overflowed files, and pure-deletion files.
  const suppressed: DiffSuppressedEntry[] = inventory
    .filter((entry) => entry.classification !== "full_patch")
    .map((entry) => ({
      ...entry,
      classification: entry.classification as "summarize" | "ignore",
      reason: entry.reason ?? "suppressed",
    }));

  return { inventory, patches, suppressed };
}
