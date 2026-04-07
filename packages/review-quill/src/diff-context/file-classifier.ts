import path from "node:path";
import type { DiffClassification, DiffFileInventoryEntry, ReviewQuillRepositoryConfig } from "../types.ts";

function normalizePattern(value: string): string {
  return value.replaceAll("\\", "/");
}

function globToRegExp(pattern: string): RegExp {
  let normalized = normalizePattern(pattern);
  let source = "^";

  // Special case: a leading `**/` should match zero-or-more directory
  // components, so `**/package-lock.json` matches both root-level
  // `package-lock.json` and nested `frontend/app/package-lock.json`.
  // Without this, `**/` compiles to `.*/` which requires at least one slash.
  if (normalized.startsWith("**/")) {
    source += "(?:.*/)?";
    normalized = normalized.slice(3);
  }

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

// Pattern-only classification. Returns the *provisional* classification
// based purely on `diffIgnore` / `diffSummarizeOnly` globs and numstat's
// `isBinary` flag. Budget-based demotion (token-budget overflow) happens
// later in `buildDiffContext`'s packer, not here.
//
// The `full_patch` return value means "eligible for a patch if the budget
// allows" — the final classification may still be `summarize` with
// reason=`budget_exceeded` if the packer can't fit the file.
export function classifyDiffFile(
  repo: ReviewQuillRepositoryConfig,
  entry: Omit<DiffFileInventoryEntry, "classification">,
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
  return { classification: "full_patch" };
}
