import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { IssueRecord } from "./db-types.ts";
import type { AppConfig } from "./types.ts";
import { ensureDir, execCommand } from "./utils.ts";

export class WorktreeManager {
  constructor(private readonly config: Pick<AppConfig, "runner">) {}

  async freshenWorktree(
    worktreePath: string,
    project: { github?: { baseBranch?: string }; repoPath: string },
    issue: Pick<IssueRecord, "issueKey">,
    logger?: Logger,
  ): Promise<void> {
    const gitBin = this.config.runner.gitBin;
    const baseBranch = project.github?.baseBranch ?? "main";

    const stashResult = await execCommand(gitBin, ["-C", worktreePath, "stash"], { timeoutMs: 30_000 });
    const didStash = stashResult.exitCode === 0 && !stashResult.stdout?.includes("No local changes");

    const fetchResult = await execCommand(gitBin, ["-C", worktreePath, "fetch", "origin", baseBranch], { timeoutMs: 60_000 });
    if (fetchResult.exitCode !== 0) {
      logger?.warn({ issueKey: issue.issueKey, stderr: fetchResult.stderr?.slice(0, 300) }, "Pre-run fetch failed, proceeding with current base");
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      return;
    }

    const mergeBaseResult = await execCommand(gitBin, ["-C", worktreePath, "merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"], { timeoutMs: 10_000 });
    if (mergeBaseResult.exitCode === 0) {
      logger?.debug({ issueKey: issue.issueKey }, "Pre-run freshen: branch already up to date");
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      return;
    }

    const rebaseResult = await execCommand(gitBin, ["-C", worktreePath, "rebase", `origin/${baseBranch}`], { timeoutMs: 120_000 });
    if (rebaseResult.exitCode !== 0) {
      await execCommand(gitBin, ["-C", worktreePath, "rebase", "--abort"], { timeoutMs: 10_000 });
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      logger?.warn({ issueKey: issue.issueKey, baseBranch }, "Pre-run freshen: rebase conflict, agent will resolve");
      return;
    }

    logger?.info({ issueKey: issue.issueKey, baseBranch }, "Pre-run freshen: rebased locally onto latest base");
    if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
  }

  async resetWorktreeToTrackedBranch(
    worktreePath: string,
    branchName: string,
    issue: Pick<IssueRecord, "issueKey">,
    logger?: Logger,
  ): Promise<void> {
    const gitBin = this.config.runner.gitBin;
    const branchFetch = await execCommand(gitBin, ["-C", worktreePath, "fetch", "origin", branchName], { timeoutMs: 60_000 });
    const hasRemoteBranch = branchFetch.exitCode === 0;

    await execCommand(gitBin, ["-C", worktreePath, "rebase", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "merge", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "cherry-pick", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "am", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "reset", "--hard", "HEAD"], { timeoutMs: 30_000 });
    await execCommand(gitBin, ["-C", worktreePath, "clean", "-fd"], { timeoutMs: 30_000 });

    const checkoutTarget = hasRemoteBranch ? `origin/${branchName}` : "HEAD";
    const checkoutResult = await execCommand(
      gitBin,
      ["-C", worktreePath, "checkout", "--ignore-other-worktrees", "-B", branchName, checkoutTarget],
      { timeoutMs: 30_000 },
    );
    if (checkoutResult.exitCode !== 0) {
      throw new Error(
        `Failed to restore ${branchName} worktree state: ${checkoutResult.stderr?.slice(0, 300) ?? "git checkout failed"}`,
      );
    }

    const resetTarget = hasRemoteBranch ? `origin/${branchName}` : "HEAD";
    const resetResult = await execCommand(gitBin, ["-C", worktreePath, "reset", "--hard", resetTarget], { timeoutMs: 30_000 });
    if (resetResult.exitCode !== 0) {
      throw new Error(
        `Failed to reset ${branchName} worktree state: ${resetResult.stderr?.slice(0, 300) ?? "git reset failed"}`,
      );
    }

    await execCommand(gitBin, ["-C", worktreePath, "clean", "-fd"], { timeoutMs: 30_000 });
    logger?.debug({ issueKey: issue.issueKey, branchName, hasRemoteBranch }, "Reset issue worktree to tracked branch state");
  }

  async restoreIdleWorktree(
    issue: Pick<IssueRecord, "issueKey" | "worktreePath" | "branchName">,
    logger?: Logger,
  ): Promise<void> {
    if (!issue.worktreePath || !issue.branchName) return;
    try {
      await this.resetWorktreeToTrackedBranch(issue.worktreePath, issue.branchName, issue, logger);
    } catch (error) {
      logger?.warn(
        {
          issueKey: issue.issueKey,
          branchName: issue.branchName,
          worktreePath: issue.worktreePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to restore idle worktree after interrupted run",
      );
    }
  }

  async ensureIssueWorktree(
    repoPath: string,
    worktreeRoot: string,
    worktreePath: string,
    branchName: string,
    options?: {
      allowExistingOutsideRoot?: boolean;
    },
  ): Promise<void> {
    if (existsSync(worktreePath)) {
      await this.assertTrustedExistingWorktree(repoPath, worktreeRoot, worktreePath, options);
      return;
    }

    await ensureDir(path.dirname(worktreePath));
    // Fetch latest main so the branch forks from a clean, up-to-date base.
    // This prevents branch contamination when local HEAD has drifted.
    // freshenWorktree in run-orchestrator acts as a secondary safety net.
    const fetchResult = await execCommand(this.config.runner.gitBin, ["-C", repoPath, "fetch", "origin", "main"], {
      timeoutMs: 60_000,
    });
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch origin/main before creating issue worktree: ${fetchResult.stderr?.slice(0, 300) ?? "git fetch failed"}`);
    }

    const addResult = await execCommand(
      this.config.runner.gitBin,
      ["-C", repoPath, "worktree", "add", "--detach", worktreePath, "origin/main"],
      { timeoutMs: 120_000 },
    );
    if (addResult.exitCode !== 0) {
      throw new Error(`Failed to create issue worktree at ${worktreePath}: ${addResult.stderr?.slice(0, 300) ?? "git worktree add failed"}`);
    }
  }

  private async assertTrustedExistingWorktree(
    repoPath: string,
    worktreeRoot: string,
    worktreePath: string,
    options?: {
      allowExistingOutsideRoot?: boolean;
    },
  ): Promise<void> {
    const worktreeStats = lstatSync(worktreePath);
    if (worktreeStats.isSymbolicLink()) {
      throw new Error(`Refusing to reuse symlinked worktree path: ${worktreePath}`);
    }
    if (!worktreeStats.isDirectory()) {
      throw new Error(`Refusing to reuse non-directory worktree path: ${worktreePath}`);
    }

    const resolvedWorktree = realpathSync(worktreePath);
    if (!options?.allowExistingOutsideRoot) {
      const resolvedRoot = realpathSync(worktreeRoot);
      if (!isPathWithinRoot(resolvedRoot, resolvedWorktree)) {
        throw new Error(`Refusing to reuse worktree outside configured root: ${worktreePath}`);
      }
    }

    const listedWorktrees = await this.listRegisteredWorktrees(repoPath);
    if (!listedWorktrees.has(resolvedWorktree)) {
      throw new Error(`Refusing to reuse unregistered worktree path: ${worktreePath}`);
    }
  }

  private async listRegisteredWorktrees(repoPath: string): Promise<Set<string>> {
    const result = await execCommand(this.config.runner.gitBin, ["-C", repoPath, "worktree", "list", "--porcelain"], {
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to verify registered worktrees for ${repoPath}`);
    }

    const worktrees = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }

      const listedPath = line.slice("worktree ".length).trim();
      if (!listedPath) {
        continue;
      }

      try {
        worktrees.add(realpathSync(listedPath));
      } catch {
        worktrees.add(path.resolve(listedPath));
      }
    }

    return worktrees;
  }
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
