import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function githubHttpExtraHeader(token: string): string {
  return `Authorization: Bearer ${token}`;
}

async function runGit(args: string[], token?: string, cwd?: string): Promise<string> {
  const commandArgs = token
    ? ["-c", `http.extraHeader=${githubHttpExtraHeader(token)}`, ...args]
    : args;
  const result = await execFileAsync("git", commandArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

export async function gitCloneBare(repoUrl: string, targetPath: string, token: string): Promise<void> {
  await runGit(["clone", "--bare", "--filter=blob:none", repoUrl, targetPath], token);
}

export async function gitFetchReviewRefs(
  cachePath: string,
  baseBranch: string,
  prNumber: number,
  token: string,
): Promise<void> {
  await runGit([
    "-C",
    cachePath,
    "fetch",
    "--force",
    "origin",
    `refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    `refs/pull/${prNumber}/head:refs/remotes/pull/${prNumber}/head`,
  ], token);
}

export async function gitWorktreeAddDetached(cachePath: string, worktreePath: string, ref: string): Promise<void> {
  await runGit(["-C", cachePath, "worktree", "add", "--detach", "--force", worktreePath, ref]);
}

export async function gitCheckoutDetached(worktreePath: string, sha: string): Promise<void> {
  await runGit(["-C", worktreePath, "checkout", "--detach", sha]);
}

export async function gitWorktreeRemove(cachePath: string, worktreePath: string): Promise<void> {
  await runGit(["-C", cachePath, "worktree", "remove", "--force", worktreePath]);
}

export async function gitDiffNameStatus(worktreePath: string, baseRef: string): Promise<string> {
  return await runGit(["-C", worktreePath, "diff", "--find-renames", "--name-status", `${baseRef}...HEAD`]);
}

export async function gitDiffNumstat(worktreePath: string, baseRef: string, filePath?: string): Promise<string> {
  const args = ["-C", worktreePath, "diff", "--find-renames", "--numstat", `${baseRef}...HEAD`];
  if (filePath) {
    args.push("--", filePath);
  }
  return await runGit(args);
}

export async function gitDiffPatch(worktreePath: string, baseRef: string, filePath: string): Promise<string> {
  return await runGit([
    "-C",
    worktreePath,
    "diff",
    "--find-renames",
    "--unified=3",
    `${baseRef}...HEAD`,
    "--",
    filePath,
  ]);
}
