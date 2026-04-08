import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// GitHub does NOT accept `Authorization: Bearer ghs_*` for git operations
// over HTTPS — that header is only valid for the REST API. For git you
// must use HTTP Basic auth with `x-access-token:<token>` as the
// credential pair, or embed `https://x-access-token:<token>@github.com/...`
// in the URL. Bearer auth fails with `remote: invalid credentials`.
//
// This format matches `packages/merge-steward/src/exec.ts:78` exactly.
// Keep both in sync — if either changes, the other should too. There's
// no shared helper because each service has different git surface area
// (steward runs full commit/push, review-quill only does bare clones).
function githubGitAuthHeader(token: string): string {
  const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
  return `Authorization: Basic ${encoded}`;
}

async function runGit(args: string[], token?: string, cwd?: string): Promise<string> {
  // Scope the auth header to github.com only, matching merge-steward.
  // The URL-scoped form is safer than a global `http.extraHeader` —
  // it prevents the token from being sent to non-github.com hosts if
  // git happens to follow a redirect.
  const commandArgs = token
    ? ["-c", `http.https://github.com/.extraheader=${githubGitAuthHeader(token)}`, ...args]
    : args;
  const result = await execFileAsync("git", commandArgs, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

function buildDiffArgs(
  worktreePath: string,
  baseRef: string,
  mode: "head" | "working-tree",
  extra: string[],
): string[] {
  const target = mode === "working-tree" ? [baseRef] : [`${baseRef}...HEAD`];
  return ["-C", worktreePath, "diff", "--find-renames", ...extra, ...target];
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

export async function gitDiffNameStatus(
  worktreePath: string,
  baseRef: string,
  mode: "head" | "working-tree" = "head",
): Promise<string> {
  return await runGit(buildDiffArgs(worktreePath, baseRef, mode, ["--name-status"]));
}

export async function gitDiffNumstat(
  worktreePath: string,
  baseRef: string,
  filePath?: string,
  mode: "head" | "working-tree" = "head",
): Promise<string> {
  const args = buildDiffArgs(worktreePath, baseRef, mode, ["--numstat"]);
  if (filePath) {
    args.push("--", filePath);
  }
  return await runGit(args);
}

export async function gitDiffPatch(
  worktreePath: string,
  baseRef: string,
  filePath: string,
  mode: "head" | "working-tree" = "head",
): Promise<string> {
  return await runGit([
    ...buildDiffArgs(worktreePath, baseRef, mode, ["--unified=5"]),
    "--",
    filePath,
  ]);
}
