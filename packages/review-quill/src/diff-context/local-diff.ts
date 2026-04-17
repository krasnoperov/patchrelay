import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  DEFAULT_DIFF_IGNORE,
  DEFAULT_DIFF_SUMMARIZE_ONLY,
  DEFAULT_PATCH_BODY_BUDGET_TOKENS,
} from "./defaults.ts";
import { buildDiffContext } from "./git-diff.ts";
import type {
  ReviewDiffContext,
  ReviewQuillRepositoryConfig,
  ReviewWorkspace,
} from "../types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.stdout;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function mergeBase(cwd: string, left: string, right: string): Promise<string> {
  return (await git(cwd, ["merge-base", left, right])).trim();
}

export function defaultDiffRepoConfig(repoFullName?: string, baseBranch?: string): ReviewQuillRepositoryConfig {
  return {
    repoId: "local",
    repoFullName: repoFullName ?? "local/working-tree",
    baseBranch: baseBranch ?? "main",
    waitForGreenChecks: false,
    requiredChecks: [],
    excludeBranches: [],
    reviewDocs: [],
    diffIgnore: [...DEFAULT_DIFF_IGNORE],
    diffSummarizeOnly: [...DEFAULT_DIFF_SUMMARIZE_ONLY],
    patchBodyBudgetTokens: DEFAULT_PATCH_BODY_BUDGET_TOKENS,
  };
}

export async function detectDefaultBranch(cwd: string): Promise<string | undefined> {
  try {
    const ref = (await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) return match[1];
  } catch {
    // origin/HEAD may not be set; fall through
  }
  for (const candidate of ["main", "master"]) {
    if (await refExists(cwd, `refs/remotes/origin/${candidate}`)) return candidate;
  }
  return undefined;
}

export function parseGitHubRepoFullName(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  const httpsMatch = trimmed.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];
  const sshMatch = trimmed.match(/^[^@\s]+@[^:]+:([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (sshMatch?.[1]) return sshMatch[1];
  return undefined;
}

export async function detectRepoFullNameFromCwd(cwd: string): Promise<string | undefined> {
  try {
    const url = (await git(cwd, ["config", "--get", "remote.origin.url"])).trim();
    return parseGitHubRepoFullName(url);
  } catch {
    return undefined;
  }
}

export async function resolveLocalBaseRef(cwd: string, baseBranch: string): Promise<string> {
  const candidates = [`refs/remotes/origin/${baseBranch}`, `origin/${baseBranch}`, baseBranch];
  for (const ref of candidates) {
    if (await refExists(cwd, ref)) return ref;
  }
  throw new Error(
    `Could not resolve a base ref for branch '${baseBranch}' in ${cwd}. Tried: ${candidates.join(", ")}`,
  );
}

export async function buildLocalDiffContext(params: {
  repo: ReviewQuillRepositoryConfig;
  cwd: string;
  baseRef?: string;
}): Promise<{ workspace: ReviewWorkspace; diff: ReviewDiffContext }> {
  let toplevel: string;
  try {
    toplevel = (await git(params.cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    throw new Error(
      `Not inside a git working tree: ${params.cwd} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (!toplevel) {
    throw new Error(`Not inside a git working tree: ${params.cwd}`);
  }

  const baseRef = params.baseRef ?? await resolveLocalBaseRef(toplevel, params.repo.baseBranch);
  const diffBaseRef = await mergeBase(toplevel, baseRef, "HEAD");
  const headSha = (await git(toplevel, ["rev-parse", "HEAD"])).trim();
  const headRef = (await git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  const workspace: ReviewWorkspace = {
    repoFullName: params.repo.repoFullName,
    cachePath: toplevel,
    worktreePath: toplevel,
    baseRef,
    diffBaseRef,
    diffTarget: "working-tree",
    headRef,
    headSha,
  };

  const diff = await buildDiffContext(params.repo, workspace);
  return { workspace, diff };
}
