import path from "node:path";
import type { DiffClassification, DiffFileInventoryEntry, ReviewQuillRepositoryConfig } from "../types.ts";

function normalizePattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizePattern(pattern);
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (!char) continue;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  source += "$";
  return new RegExp(source);
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalizedPath = normalizePattern(filePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalizedPath));
}

export function classifyDiffFile(
  repo: ReviewQuillRepositoryConfig,
  entry: Omit<DiffFileInventoryEntry, "classification">,
  fullPatchIndex: number,
): { classification: DiffClassification; reason?: string } {
  const normalizedPath = path.posix.normalize(entry.path.replaceAll("\\", "/"));
  if (matchesAny(normalizedPath, repo.diffIgnore)) {
    return { classification: "ignore", reason: "ignored_by_policy" };
  }
  if (entry.isBinary) {
    return { classification: "summarize", reason: "binary_file" };
  }
  if (matchesAny(normalizedPath, repo.diffSummarizeOnly)) {
    return { classification: "summarize", reason: "summarize_only_policy" };
  }
  if (fullPatchIndex >= repo.maxFilesWithFullPatch) {
    return { classification: "summarize", reason: "patch_budget_exceeded" };
  }
  return { classification: "full_patch" };
}
