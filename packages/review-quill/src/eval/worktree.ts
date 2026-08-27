import { execFile } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { detectRepoFullNameFromCwd } from "../diff-context/index.ts";
import type { ReviewWorkspace } from "../types.ts";
import type { ReviewEvalCase } from "./case-file.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return result.stdout.trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commitExists(checkout: string, sha: string): Promise<boolean> {
  try {
    await git(checkout, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveRepositoryCheckout(repository: string, reposDir?: string): Promise<string> {
  const root = path.resolve(reposDir ?? process.env.REVIEW_QUILL_EVAL_REPOS_DIR ?? path.join(homedir(), "projects"));
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error(`Repository must use owner/name form: ${repository}`);
  const candidates = [path.join(root, owner, name), path.join(root, name)];
  for (const candidate of candidates) {
    if (!await exists(candidate)) continue;
    if (await detectRepoFullNameFromCwd(candidate) === repository) return candidate;
  }
  throw new Error(`No checkout for ${repository} under ${root}. Set REVIEW_QUILL_EVAL_REPOS_DIR to the parent of local repositories.`);
}

async function ensureCaseCommits(checkout: string, evalCase: ReviewEvalCase): Promise<void> {
  if (await commitExists(checkout, evalCase.baseSha) && await commitExists(checkout, evalCase.headSha)) return;
  await git(checkout, ["fetch", "--no-tags", "origin", evalCase.baseBranch, `refs/pull/${evalCase.pullRequest}/head`]);
  if (!await commitExists(checkout, evalCase.baseSha) || !await commitExists(checkout, evalCase.headSha)) {
    throw new Error(`Could not resolve frozen commits for ${evalCase.id}`);
  }
}

export interface PreparedEvalWorktree {
  workspace: ReviewWorkspace;
  dispose(): Promise<void>;
}

export async function prepareEvalWorktree(evalCase: ReviewEvalCase, checkout: string): Promise<PreparedEvalWorktree> {
  await ensureCaseCommits(checkout, evalCase);
  const tempRoot = await mkdtemp(path.join(tmpdir(), "review-quill-eval-"));
  const worktreePath = path.join(tempRoot, "checkout");
  let registered = false;
  try {
    await git(checkout, ["worktree", "add", "--detach", worktreePath, evalCase.headSha]);
    registered = true;
    const commonDirRaw = await git(checkout, ["rev-parse", "--git-common-dir"]);
    const cachePath = path.resolve(checkout, commonDirRaw);
    return {
      workspace: {
        repoFullName: evalCase.repository,
        cachePath,
        worktreePath,
        baseRef: evalCase.baseSha,
        diffBaseRef: evalCase.baseSha,
        diffTarget: "head",
        headRef: evalCase.headSha,
        headSha: evalCase.headSha,
        prBaseSha: evalCase.baseSha,
      },
      dispose: async () => {
        try {
          await git(checkout, ["worktree", "remove", "--force", worktreePath]);
        } finally {
          await rm(tempRoot, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    if (registered) {
      try {
        await git(checkout, ["worktree", "remove", "--force", worktreePath]);
      } catch {
        // Keep the original preparation failure; the temp path is removed below.
      }
    }
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function isChangedNewLine(worktreePath: string, baseSha: string, filePath: string, line: number): Promise<boolean> {
  const patch = await git(worktreePath, ["diff", "--unified=0", baseSha, "HEAD", "--", filePath]);
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0 && line >= start && line < start + count) return true;
  }
  return false;
}
