import { gitDiffPatch } from "./review-workspace/git.ts";
import type { ReviewVerdict, ReviewWorkspace } from "./types.ts";

const MAX_ANCHOR_SHIFT = 5;

export function changedNewLinesFromPatch(patch: string): Set<number> {
  const changed = new Set<number>();
  let newLine: number | undefined;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk?.[1]) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (newLine === undefined || line.startsWith("\\ No newline")) continue;
    if (line.startsWith("+")) {
      changed.add(newLine);
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return changed;
}

export function nearestChangedLine(lines: Set<number>, requested: number): number | undefined {
  if (lines.has(requested)) return requested;
  let nearest: number | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const candidateDistance = Math.abs(line - requested);
    if (candidateDistance < distance || (candidateDistance === distance && line < (nearest ?? line))) {
      nearest = line;
      distance = candidateDistance;
    }
  }
  return distance <= MAX_ANCHOR_SHIFT ? nearest : undefined;
}

export async function alignFindingAnchors(
  workspace: ReviewWorkspace,
  verdict: ReviewVerdict,
): Promise<ReviewVerdict> {
  const baseRef = workspace.diffBaseRef ?? workspace.baseRef;
  const mode = workspace.diffTarget ?? "head";
  const changedByPath = new Map<string, Set<number>>();
  for (const path of new Set(verdict.findings.map((finding) => finding.path))) {
    const patch = await gitDiffPatch(workspace.worktreePath, baseRef, path, mode);
    changedByPath.set(path, changedNewLinesFromPatch(patch));
  }
  return {
    ...verdict,
    findings: verdict.findings.map((finding) => {
      const line = nearestChangedLine(changedByPath.get(finding.path) ?? new Set(), finding.line);
      return line === undefined || line === finding.line ? finding : { ...finding, line };
    }),
  };
}
