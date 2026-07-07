import { existsSync, lstatSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import { isIssueTerminalProjection } from "./issue-execution-state.ts";
import type { AppConfig, ProjectConfig } from "./types.ts";
import { execCommand } from "./utils.ts";

export interface WorktreeCleanupOptions {
  dryRun?: boolean | undefined;
  retentionHours?: number | undefined;
  now?: Date | undefined;
}

export interface WorktreeCleanupResult {
  cutoffIso: string;
  scanned: number;
  eligible: number;
  deleted: number;
  missing: number;
  skippedActive: number;
  skippedRecent: number;
  skippedState: number;
  skippedOutsideRoot: number;
  skippedDirty: number;
  failed: number;
  dryRun: boolean;
  deletedWorktrees: Array<{ issueKey?: string | undefined; worktreePath: string }>;
  skippedDirtyWorktrees: Array<{ issueKey?: string | undefined; worktreePath: string; summary: string }>;
  failures: Array<{ issueKey?: string | undefined; worktreePath: string; error: string }>;
}

export async function runTerminalWorktreeCleanup(params: {
  db: PatchRelayDatabase;
  config: AppConfig;
  logger?: Logger | undefined;
  options?: WorktreeCleanupOptions | undefined;
}): Promise<WorktreeCleanupResult> {
  const retentionHours = params.options?.retentionHours ?? params.config.maintenance.worktreeRetentionHours;
  const now = params.options?.now ?? new Date();
  const cutoffMs = now.getTime() - retentionHours * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();
  const dryRun = params.options?.dryRun === true;
  const projectByRoot = buildProjectRoots(params.config.projects);
  const result: WorktreeCleanupResult = {
    cutoffIso,
    scanned: 0,
    eligible: 0,
    deleted: 0,
    missing: 0,
    skippedActive: 0,
    skippedRecent: 0,
    skippedState: 0,
    skippedOutsideRoot: 0,
    skippedDirty: 0,
    failed: 0,
    dryRun,
    deletedWorktrees: [],
    skippedDirtyWorktrees: [],
    failures: [],
  };
  const reposToPrune = new Set<string>();

  for (const issue of params.db.listIssues()) {
    result.scanned += 1;
    if (!issue.worktreePath) continue;
    if (!isIssueTerminalProjection(issue)) {
      result.skippedState += 1;
      continue;
    }
    if (issue.activeRunId !== undefined) {
      result.skippedActive += 1;
      continue;
    }
    if (Date.parse(issue.updatedAt) > cutoffMs) {
      result.skippedRecent += 1;
      continue;
    }

    const project = resolveProjectForWorktree(projectByRoot, issue.worktreePath);
    if (!project) {
      result.skippedOutsideRoot += 1;
      continue;
    }
    if (!existsSync(issue.worktreePath)) {
      result.missing += 1;
      continue;
    }

    result.eligible += 1;
    const dirty = await trackedDirtySummary(params.config.runner.gitBin, issue.worktreePath);
    if (dirty !== undefined) {
      result.skippedDirty += 1;
      result.skippedDirtyWorktrees.push({
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        worktreePath: issue.worktreePath,
        summary: dirty,
      });
      continue;
    }

    if (!dryRun) {
      try {
        await rm(issue.worktreePath, { recursive: true, force: true });
        reposToPrune.add(project.repoPath);
      } catch (error) {
        result.failed += 1;
        result.failures.push({
          ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
          worktreePath: issue.worktreePath,
          error: formatError(error),
        });
        continue;
      }
    }

    result.deleted += 1;
    result.deletedWorktrees.push({
      ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
      worktreePath: issue.worktreePath,
    });
  }

  for (const repoPath of reposToPrune) {
    try {
      const prune = await execCommand(params.config.runner.gitBin, ["-C", repoPath, "worktree", "prune"], { timeoutMs: 60_000 });
      if (prune.exitCode !== 0) {
        params.logger?.warn(
          { repoPath, error: (prune.stderr || prune.stdout).trim() || `exit ${prune.exitCode}` },
          "Failed to prune stale git worktree registrations",
        );
      }
    } catch (error) {
      params.logger?.warn(
        { repoPath, error: formatError(error) },
        "Failed to prune stale git worktree registrations",
      );
    }
  }

  return result;
}

function buildProjectRoots(projects: ProjectConfig[]): Array<ProjectConfig & { resolvedWorktreeRoot: string }> {
  return projects.map((project) => ({
    ...project,
    resolvedWorktreeRoot: resolveExistingPath(project.worktreeRoot),
  }));
}

function resolveProjectForWorktree(
  projects: Array<ProjectConfig & { resolvedWorktreeRoot: string }>,
  worktreePath: string,
): (ProjectConfig & { resolvedWorktreeRoot: string }) | undefined {
  const resolvedWorktreePath = resolveExistingPath(worktreePath);
  return projects.find((project) => isPathWithinRoot(project.resolvedWorktreeRoot, resolvedWorktreePath));
}

function resolveExistingPath(targetPath: string): string {
  try {
    if (existsSync(targetPath) && !lstatSync(targetPath).isSymbolicLink()) {
      return realpathSync(targetPath);
    }
  } catch {
    // Fall through to the lexical path. A missing terminal worktree is safe to count as missing.
  }
  return path.resolve(targetPath);
}

async function trackedDirtySummary(gitBin: string, worktreePath: string): Promise<string | undefined> {
  const result = await execCommand(gitBin, ["-C", worktreePath, "status", "--porcelain=v1", "-uno"], { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    return `git status failed: ${(result.stderr || result.stdout).trim() || `exit ${result.exitCode}`}`;
  }
  const summary = result.stdout.trim();
  return summary || undefined;
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
