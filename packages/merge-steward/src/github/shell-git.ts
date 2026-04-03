import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { GitOperations, SpeculativeBranchBuilder } from "../interfaces.ts";
import type { MergeResult } from "../types.ts";
import { exec } from "../exec.ts";

/** Extract conflict file names from git merge stderr. */
function parseConflicts(stderr: string): string[] | undefined {
  const files = stderr
    .split("\n")
    .filter((line) => line.includes("CONFLICT"))
    .map((line) => {
      const match = line.match(/CONFLICT.*?:\s+(.+)/);
      return match ? match[1]! : line;
    });
  return files.length > 0 ? files : undefined;
}

export interface BotIdentity {
  name: string;
  email: string;
}

export class ShellGitOperations implements GitOperations, SpeculativeBranchBuilder {
  private readonly worktreeBase: string;
  private botIdentity: BotIdentity | undefined;

  constructor(
    private readonly clonePath: string,
    private readonly repoFullName: string,
    private readonly gitBin: string = "git",
  ) {
    this.worktreeBase = `${clonePath}-worktrees`;
  }

  setBotIdentity(identity: BotIdentity): void {
    this.botIdentity = identity;
  }

  private git(args: string[], opts?: { allowNonZero?: boolean; timeoutMs?: number }) {
    return exec(this.gitBin, ["-C", this.clonePath, ...args], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
      allowNonZero: opts?.allowNonZero,
      githubRepoFullName: this.repoFullName,
    });
  }

  /** Run a git command in a specific directory (worktree). */
  private gitIn(cwd: string, args: string[], opts?: { allowNonZero?: boolean; timeoutMs?: number }) {
    return exec(this.gitBin, ["-C", cwd, ...args], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
      allowNonZero: opts?.allowNonZero,
      githubRepoFullName: this.repoFullName,
    });
  }

  async fetch(remote = "origin"): Promise<void> {
    await this.git(["fetch", remote], { timeoutMs: 60_000 });
  }

  async headSha(branch: string): Promise<string> {
    const result = await this.git(["rev-parse", branch]);
    return result.stdout.trim();
  }

  async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.git(["merge-base", "--is-ancestor", ancestor, descendant], { allowNonZero: true });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`git merge-base --is-ancestor failed: ${result.stderr || result.stdout}`);
  }

  async push(branch: string, force = false, targetBranch?: string): Promise<void> {
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    const refspec = targetBranch ? `${branch}:${targetBranch}` : branch;
    args.push("origin", refspec);
    await this.git(args, { timeoutMs: 60_000 });
  }

  // ─── SpeculativeBranchBuilder ───────────────────────────────

  /**
   * Build a speculative merge branch using an isolated git worktree.
   * Each call gets its own working directory — no shared mutable state.
   * The worktree is removed after the merge; the branch ref persists
   * so the reconciler can push it and reference its SHA.
   */
  async buildSpeculative(prBranch: string, baseBranch: string, specName: string, mergeMessage?: string): Promise<MergeResult> {
    const wtPath = join(this.worktreeBase, specName);

    // Clean up any leftover worktree/branch from a previous run.
    await this.git(["worktree", "remove", "--force", wtPath], { allowNonZero: true });
    await this.git(["branch", "-D", specName], { allowNonZero: true });
    await this.git(["worktree", "prune"], { allowNonZero: true });

    // Create isolated worktree with spec branch starting at baseBranch.
    mkdirSync(this.worktreeBase, { recursive: true });
    await this.git(["worktree", "add", "-B", specName, wtPath, baseBranch]);

    // Override git identity so merge commits are attributed to the steward, not the clone owner.
    if (this.botIdentity) {
      await this.gitIn(wtPath, ["config", "user.name", this.botIdentity.name]);
      await this.gitIn(wtPath, ["config", "user.email", this.botIdentity.email]);
    }

    // Merge PR into spec branch inside the worktree.
    // PR branches are always remote refs — use explicit origin/ prefix
    // because git DWIM doesn't reliably resolve bare names in worktrees.
    const mergeRef = prBranch.startsWith("origin/") ? prBranch : `origin/${prBranch}`;
    const mergeArgs = ["merge", "--no-ff"];
    if (mergeMessage) mergeArgs.push("-m", mergeMessage);
    mergeArgs.push(mergeRef);
    const result = await this.gitIn(wtPath, mergeArgs, { allowNonZero: true });

    if (result.exitCode !== 0) {
      const conflictFiles = parseConflicts(result.stderr);

      // Lockfile-only conflicts can be auto-resolved by regenerating.
      if (await this.tryResolveLockfileConflict(wtPath)) {
        const sha = (await this.gitIn(wtPath, ["rev-parse", "HEAD"])).stdout.trim();
        await this.git(["worktree", "remove", "--force", wtPath], { allowNonZero: true });
        return { success: true, sha };
      }

      await this.gitIn(wtPath, ["merge", "--abort"], { allowNonZero: true });
      await this.git(["worktree", "remove", "--force", wtPath], { allowNonZero: true });
      await this.git(["branch", "-D", specName], { allowNonZero: true });
      return { success: false, conflictFiles };
    }

    const sha = (await this.gitIn(wtPath, ["rev-parse", "HEAD"])).stdout.trim();
    // Remove worktree but keep the branch — reconciler needs it for push/CI.
    await this.git(["worktree", "remove", "--force", wtPath], { allowNonZero: true });
    return { success: true, sha };
  }

  /**
   * During a merge conflict, check if the only unmerged files are lockfiles
   * (package-lock.json). If so, resolve by regenerating from the merged
   * package.json via `npm install --package-lock-only`.
   */
  private async tryResolveLockfileConflict(wtPath: string): Promise<boolean> {
    try {
      const unmerged = await this.gitIn(wtPath, ["diff", "--name-only", "--diff-filter=U"]);
      const files = unmerged.stdout.trim().split("\n").filter(Boolean);
      if (files.length === 0 || !files.every((f) => f.endsWith("package-lock.json"))) {
        return false;
      }

      for (const file of files) {
        await this.gitIn(wtPath, ["checkout", "--ours", "--", file]);
      }

      const npmResult = await exec("npm", ["install", "--package-lock-only"], {
        cwd: wtPath,
        timeoutMs: 60_000,
      });
      if (npmResult.exitCode !== 0) return false;

      for (const file of files) {
        await this.gitIn(wtPath, ["add", file]);
      }
      const commitResult = await this.gitIn(wtPath, ["commit", "--no-edit"], { allowNonZero: true });
      return commitResult.exitCode === 0;
    } catch {
      return false;
    }
  }

  async deleteSpeculative(specName: string): Promise<void> {
    const wtPath = join(this.worktreeBase, specName);
    await this.git(["worktree", "remove", "--force", wtPath], { allowNonZero: true });
    await this.git(["branch", "-D", specName], { allowNonZero: true });
  }
}
