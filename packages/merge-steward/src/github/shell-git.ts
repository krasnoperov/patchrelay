import type { GitOperations, SpeculativeBranchBuilder } from "../interfaces.ts";
import type { MergeResult, RebaseResult } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * Real git operations via shell git binary. Operates in the steward's
 * own local clone. The clone path is set at construction time.
 */
export class ShellGitOperations implements GitOperations, SpeculativeBranchBuilder {
  constructor(
    private readonly clonePath: string,
    private readonly gitBin: string = "git",
  ) {}

  private git(args: string[], opts?: { allowNonZero?: boolean; timeoutMs?: number }) {
    return exec(this.gitBin, ["-C", this.clonePath, ...args], {
      timeoutMs: opts?.timeoutMs ?? 120_000,
      allowNonZero: opts?.allowNonZero,
    });
  }

  async fetch(remote = "origin"): Promise<void> {
    await this.git(["fetch", remote], { timeoutMs: 60_000 });
  }

  async headSha(branch: string): Promise<string> {
    const result = await this.git(["rev-parse", branch]);
    return result.stdout.trim();
  }

  async rebase(branch: string, onto: string): Promise<RebaseResult> {
    await this.git(["checkout", branch]);
    const result = await this.git(["rebase", onto], { allowNonZero: true });
    if (result.exitCode !== 0) {
      // Abort the failed rebase.
      await this.git(["rebase", "--abort"], { allowNonZero: true });
      const conflicts = result.stderr
        .split("\n")
        .filter((line) => line.includes("CONFLICT"))
        .map((line) => {
          const match = line.match(/CONFLICT.*?:\s+(.+)/);
          return match ? match[1]! : line;
        });
      return { success: false, conflictFiles: conflicts.length > 0 ? conflicts : undefined };
    }
    const newSha = await this.headSha("HEAD");
    return { success: true, newHeadSha: newSha };
  }

  async push(branch: string, force = false): Promise<void> {
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    args.push("origin", branch);
    await this.git(args, { timeoutMs: 60_000 });
  }

  // ─── SpeculativeBranchBuilder ───────────────────────────────

  async buildSpeculative(prBranch: string, baseBranch: string, specName: string): Promise<MergeResult> {
    // Delete existing spec branch if any.
    await this.git(["branch", "-D", specName], { allowNonZero: true });

    // Create spec branch from base.
    await this.git(["checkout", "-B", specName, baseBranch]);

    // Merge the PR branch into it.
    const result = await this.git(["merge", "--no-ff", prBranch], { allowNonZero: true });
    if (result.exitCode !== 0) {
      await this.git(["merge", "--abort"], { allowNonZero: true });
      await this.git(["checkout", "-"], { allowNonZero: true });
      return { success: false };
    }

    const sha = (await this.git(["rev-parse", "HEAD"])).stdout.trim();
    await this.git(["checkout", "-"], { allowNonZero: true });
    return { success: true, sha };
  }

  async deleteSpeculative(specName: string): Promise<void> {
    await this.git(["branch", "-D", specName], { allowNonZero: true });
  }
}
