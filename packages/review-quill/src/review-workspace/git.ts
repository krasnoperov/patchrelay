import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
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

export async function gitMergeBase(worktreePath: string, left: string, right: string): Promise<string> {
  const out = await runGit(["-C", worktreePath, "merge-base", left, right]);
  return out.trim();
}

// Compute the stable patch-id of a PR's diff against its merge-base with
// `base`. Identity follows §2.3 of the contract:
//   git diff $(git merge-base <base> <head>)..<head> | git patch-id --stable
//
// The two halves are run as separate spawned processes connected via a
// stream pipe — `--stable` canonicalizes per-file order so commit reorders
// within a range produce the same id.
//
// Returns undefined when the diff is empty (no changes) or git emits no
// output (patch-id prints nothing for an empty input). Throws on any
// non-zero exit from either process; the caller is expected to fall
// through to the normal review path on failure.
export async function gitPatchId(
  worktreePath: string,
  base: string,
  head: string,
): Promise<string | undefined> {
  const mergeBaseSha = await gitMergeBase(worktreePath, base, head);
  // Capture the diff as a Buffer to preserve byte-exact bytes flowing
  // into patch-id; `git patch-id --stable` canonicalizes file order
  // itself but is sensitive to byte content.
  const diffBuf = await new Promise<Buffer>((resolve, reject) => {
    const proc = spawn("git", ["-C", worktreePath, "diff", `${mergeBaseSha}..${head}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const errChunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git diff failed (code ${code}): ${errChunks.join("")}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });

  if (diffBuf.length === 0) {
    return undefined;
  }

  const patchIdOut = await new Promise<string>((resolve, reject) => {
    const proc = spawn("git", ["patch-id", "--stable"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    const errChunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => stdout += d.toString("utf8"));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`git patch-id --stable failed (code ${code}): ${errChunks.join("")}`));
        return;
      }
      resolve(stdout);
    });
    proc.stdin.write(diffBuf);
    proc.stdin.end();
  });

  // Output format: "<patch-id> <commit-sha>" (one or more lines for a
  // multi-commit range; we use the patch-id from the first line, which
  // covers the entire range in --stable mode).
  const firstLine = patchIdOut.split("\n").find((line) => line.trim().length > 0);
  if (!firstLine) return undefined;
  const id = firstLine.trim().split(/\s+/)[0];
  return id && id.length > 0 ? id : undefined;
}

export type MergeTreeResult =
  | { conflict: false; treeId: string }
  | { conflict: true };

// `git merge-tree --write-tree` returns a tree object id on success.
// Nonzero exit signals "cannot integrate" — a real conflict, not an
// error condition (per §2.3 of the contract). Caller decides what to
// do with conflicts.
export async function gitMergeTree(
  worktreePath: string,
  base: string,
  head: string,
): Promise<MergeTreeResult> {
  return await new Promise<MergeTreeResult>((resolve, reject) => {
    const proc = spawn("git", ["-C", worktreePath, "merge-tree", "--write-tree", base, head], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const errChunks: string[] = [];
    proc.stdout.on("data", (d: Buffer) => stdout += d.toString("utf8"));
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d.toString("utf8")));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        const treeId = stdout.trim().split("\n")[0]?.trim() ?? "";
        if (treeId.length === 0) {
          reject(new Error(`git merge-tree --write-tree returned empty output: ${errChunks.join("")}`));
          return;
        }
        resolve({ conflict: false, treeId });
        return;
      }
      // git merge-tree prints "<base-tree>\n<conflicting paths>\n" to
      // stdout on conflict (exit 1) and an actual error message to
      // stderr on operand misuse (exit 129). Treat 129 as a real error.
      if (code === 1) {
        resolve({ conflict: true });
        return;
      }
      reject(new Error(`git merge-tree --write-tree failed (code ${code}): ${errChunks.join("")}`));
    });
  });
}
