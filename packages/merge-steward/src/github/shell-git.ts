import type { GitOperations } from "../interfaces.ts";
import type { MergeResult, RebaseResult } from "../types.ts";
import { exec } from "../exec.ts";

/**
 * Real git operations via shell git binary. Operates in the steward's
 * own local clone. The clone path is set at construction time.
 */
export class ShellGitOperations implements GitOperations {
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

  async changedFiles(branch: string, base: string): Promise<string[]> {
    const result = await this.git(["diff", "--name-only", `${base}...${branch}`]);
    return result.stdout.trim().split("\n").filter(Boolean);
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

  async merge(source: string, into: string): Promise<MergeResult> {
    await this.git(["checkout", into]);
    const result = await this.git(["merge", "--no-ff", source], { allowNonZero: true });
    if (result.exitCode !== 0) {
      await this.git(["merge", "--abort"], { allowNonZero: true });
      return { success: false };
    }
    const sha = await this.headSha("HEAD");
    return { success: true, sha };
  }

  async push(branch: string, force = false): Promise<void> {
    const args = ["push"];
    if (force) args.push("--force-with-lease");
    args.push("origin", branch);
    await this.git(args, { timeoutMs: 60_000 });
  }

  async createBranch(name: string, from: string): Promise<void> {
    await this.git(["branch", name, from]);
  }

  async deleteBranch(name: string): Promise<void> {
    await this.git(["branch", "-D", name]);
  }
}
