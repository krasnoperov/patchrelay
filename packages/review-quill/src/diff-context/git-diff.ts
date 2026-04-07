import {
  gitDiffNameStatus,
  gitDiffNumstat,
  gitDiffPatch,
} from "../review-workspace/git.ts";
import { classifyDiffFile } from "./file-classifier.ts";
import type {
  DiffFileInventoryEntry,
  DiffFilePatchEntry,
  DiffSuppressedEntry,
  ReviewDiffContext,
  ReviewQuillRepositoryConfig,
  ReviewWorkspace,
} from "../types.ts";

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
  const raw = (await gitDiffNumstat(workspace.worktreePath, baseRef, filePath)).trim();
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

export async function buildDiffContext(
  repo: ReviewQuillRepositoryConfig,
  workspace: ReviewWorkspace,
): Promise<ReviewDiffContext> {
  const baseRef = workspace.baseRef;
  const nameStatus = await gitDiffNameStatus(workspace.worktreePath, baseRef);
  const inventory: DiffFileInventoryEntry[] = [];
  const patches: DiffFilePatchEntry[] = [];
  const suppressed: DiffSuppressedEntry[] = [];

  let fullPatchIndex = 0;
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
    const classification = classifyDiffFile(repo, provisional, fullPatchIndex);
    const inventoryEntry: DiffFileInventoryEntry = {
      ...provisional,
      classification: classification.classification,
      ...(classification.reason ? { reason: classification.reason } : {}),
    };
    inventory.push(inventoryEntry);

    if (classification.classification !== "full_patch") {
      suppressed.push({
        ...inventoryEntry,
        classification: classification.classification,
        reason: classification.reason ?? "suppressed",
      });
      continue;
    }

    const patch = await gitDiffPatch(workspace.worktreePath, baseRef, parsed.path);
    const patchLineCount = patch.split(/\r?\n/).length;
    const patchBytes = Buffer.byteLength(patch, "utf8");
    if (patchLineCount > repo.maxPatchLines || patchBytes > repo.maxPatchBytes) {
      const reason = patchLineCount > repo.maxPatchLines ? "patch_too_large_lines" : "patch_too_large_bytes";
      const summarized: DiffSuppressedEntry = {
        ...inventoryEntry,
        classification: "summarize",
        reason,
      };
      inventory[inventory.length - 1] = summarized;
      suppressed.push(summarized);
      continue;
    }

    patches.push({
      ...inventoryEntry,
      classification: "full_patch",
      patch,
    });
    fullPatchIndex += 1;
  }

  return { inventory, patches, suppressed };
}
