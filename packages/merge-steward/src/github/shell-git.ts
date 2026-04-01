import type { GitOperations, SpeculativeBranchBuilder } from "../interfaces.ts";
import type { MergeResult } from "../types.ts";
import { exec } from "../exec.ts";

/** Extract conflict file names from git rebase/merge stderr. */
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

export class ShellGitOperations implements GitOperations, SpeculativeBranchBuilder {
  constructor(
    private readonly clonePath: string,
    private readonly repoFullName: string,
    private readonly gitBin: string = "git",
  ) {}

  private git(args: string[], opts?: { allowNonZero?: boolean; timeoutMs?: number }) {
    return exec(this.gitBin, ["-C", this.clonePath, ...args], {
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

  async mergeBaseInto(branch: string, base: string): Promise<MergeResult> {
    const remoteBranchRef = `refs/remotes/origin/${branch}`;
    const remoteBranchExists = await this.git(["show-ref", "--verify", remoteBranchRef], { allowNonZero: true });
    if (remoteBranchExists.exitCode === 0) {
      await this.git(["checkout", "-B", branch, `origin/${branch}`]);
    } else {
      await this.git(["checkout", branch]);
    }
    const result = await this.git(["merge", "--no-ff", "--no-edit", base], { allowNonZero: true });
    if (result.exitCode !== 0) {
      await this.git(["merge", "--abort"], { allowNonZero: true });
      return { success: false, conflictFiles: parseConflicts(result.stderr) };
    }
    const newSha = await this.headSha("HEAD");
    return { success: true, sha: newSha };
  }

  async push(branch: string, force = false): Promise<void> {
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    args.push("origin", branch);
    await this.git(args, { timeoutMs: 60_000 });
  }

  // ─── SpeculativeBranchBuilder ───────────────────────────────

  async buildSpeculative(prBranch: string, baseBranch: string, specName: string): Promise<MergeResult> {
    await this.git(["branch", "-D", specName], { allowNonZero: true });
    await this.git(["checkout", "-B", specName, baseBranch]);

    const result = await this.git(["merge", "--no-ff", prBranch], { allowNonZero: true });
    if (result.exitCode !== 0) {
      const conflictFiles = parseConflicts(result.stderr);
      await this.git(["merge", "--abort"], { allowNonZero: true });
      await this.git(["checkout", "-"], { allowNonZero: true });
      return { success: false, conflictFiles };
    }

    const sha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    await this.git(["checkout", "-"], { allowNonZero: true });
    return { success: true, sha };
  }

  async deleteSpeculative(specName: string): Promise<void> {
    await this.git(["branch", "-D", specName], { allowNonZero: true });
  }
}
