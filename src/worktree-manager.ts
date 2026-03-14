import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";
import { ensureDir, execCommand } from "./utils.ts";

export class WorktreeManager {
  constructor(private readonly config: Pick<AppConfig, "runner">) {}

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
    await execCommand(this.config.runner.gitBin, ["-C", repoPath, "worktree", "add", "--force", "-B", branchName, worktreePath, "HEAD"], {
      timeoutMs: 120_000,
    });
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
