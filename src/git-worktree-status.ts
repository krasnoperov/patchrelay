import { spawnSync } from "node:child_process";

export interface GitWorktreeStatus {
  dirty: boolean;
  mergeInProgress: boolean;
  unmergedPaths: string[];
  changedPaths: string[];
  summary?: string | undefined;
}

const UNMERGED_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function parsePorcelainPath(line: string): string {
  const raw = line.slice(3).trim();
  const renameSeparator = " -> ";
  const renamed = raw.includes(renameSeparator) ? raw.slice(raw.indexOf(renameSeparator) + renameSeparator.length) : raw;
  return renamed.replace(/^"|"$/g, "");
}

function hasGitPath(worktreePath: string, pathName: string): boolean {
  const result = spawnSync("git", ["-C", worktreePath, "rev-parse", "--git-path", pathName], { encoding: "utf8" });
  if (result.status !== 0) return false;
  const resolved = result.stdout.trim();
  if (!resolved) return false;
  return spawnSync("test", ["-f", resolved]).status === 0;
}

export function inspectGitWorktreeStatus(worktreePath: string): GitWorktreeStatus {
  const result = spawnSync("git", ["-C", worktreePath, "status", "--porcelain=v1", "-uall"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return {
      dirty: true,
      mergeInProgress: false,
      unmergedPaths: [],
      changedPaths: [],
      summary: `Unable to inspect worktree: ${(result.stderr || result.stdout).trim() || "git status failed"}`,
    };
  }

  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const changedPaths = lines.map(parsePorcelainPath);
  const unmergedPaths = lines
    .filter((line) => UNMERGED_CODES.has(line.slice(0, 2)) || line.slice(0, 2).includes("U"))
    .map(parsePorcelainPath);
  const mergeInProgress = hasGitPath(worktreePath, "MERGE_HEAD")
    || hasGitPath(worktreePath, "REBASE_HEAD")
    || hasGitPath(worktreePath, "CHERRY_PICK_HEAD")
    || hasGitPath(worktreePath, "REVERT_HEAD");

  // A worktree is only actionably dirty when `git status` reports something —
  // staged/unstaged/untracked changes, or unmerged (conflicted) paths. A
  // lingering MERGE_HEAD/REBASE_HEAD marker over an OTHERWISE-CLEAN tree (zero
  // porcelain lines) is a vestigial in-progress flag with no work behind it
  // (e.g. a merge that produced no content change but never cleared its head).
  // Treating that as dirty triggered a spurious "continue to publish" loop, so
  // a real merge-in-progress with conflicts still surfaces here via its
  // unmerged porcelain lines, while an empty marker does not.
  const dirty = lines.length > 0;
  const summary = dirty
    ? unmergedPaths.length > 0
      ? `Worktree has unresolved merge conflicts: ${unmergedPaths.join(", ")}`
      : changedPaths.length > 0
        ? `Worktree has uncommitted changes: ${changedPaths.slice(0, 12).join(", ")}${changedPaths.length > 12 ? ", ..." : ""}`
        : "Worktree has an unfinished git operation"
    : undefined;

  return {
    dirty,
    mergeInProgress,
    unmergedPaths,
    changedPaths,
    ...(summary ? { summary } : {}),
  };
}

export function isRepairRunType(runType: string): boolean {
  return runType === "review_fix" || runType === "branch_upkeep" || runType === "ci_repair" || runType === "queue_repair";
}

export interface DirtyWorktreeEventPayload {
  dirtyWorktree: true;
  mergeInProgress: boolean;
  unmergedPaths: string[];
  changedPaths: string[];
  summary?: string | undefined;
}

export function dirtyWorktreeEventPayload(status: GitWorktreeStatus): DirtyWorktreeEventPayload | undefined {
  if (!status.dirty) return undefined;
  return {
    dirtyWorktree: true,
    mergeInProgress: status.mergeInProgress,
    unmergedPaths: status.unmergedPaths,
    changedPaths: status.changedPaths,
    ...(status.summary !== undefined ? { summary: status.summary } : {}),
  };
}
