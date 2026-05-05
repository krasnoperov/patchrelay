import { spawnSync } from "node:child_process";

// Plan §2.3 / §4.1: stable change identity for a worktree's head
// against a base ref. Two values:
//
// - `patchId`: `git diff <base>..<head> | git patch-id --stable`. Stable
//   across rebases and trivial reordering.
// - `integrationTreeId`: `git merge-tree --write-tree <base> <head>` —
//   the tree id of the merged result. Returns `undefined` on conflict.
//
// Each call is "fail conservative": any git error produces
// `undefined` rather than throwing. Callers must treat `undefined` as
// "identity unknown" and never use it as a positive match. Plan
// §4.2(c) requires this conservative stance — a flaky probe that
// flagged a real change as no-op would silently corrupt the
// reactive cascade.

export interface ChangeIdentity {
  patchId?: string | undefined;
  integrationTreeId?: string | undefined;
  baseSha?: string | undefined;
  headSha?: string | undefined;
}

export function computeChangeIdentityFromWorktree(params: {
  worktreePath: string;
  baseRef: string;
  headSha?: string;
}): ChangeIdentity {
  const cwd = params.worktreePath;
  const baseSha = resolveSha(cwd, params.baseRef);
  const headSha = params.headSha
    ? resolveSha(cwd, params.headSha)
    : resolveSha(cwd, "HEAD");
  if (!baseSha || !headSha) return {};

  const patchId = computePatchId(cwd, baseSha, headSha);
  const integrationTreeId = computeIntegrationTreeId(cwd, baseSha, headSha);
  return {
    ...(patchId ? { patchId } : {}),
    ...(integrationTreeId ? { integrationTreeId } : {}),
    baseSha,
    headSha,
  };
}

export function resolveSha(cwd: string, ref: string): string | undefined {
  const result = spawnSync("git", ["-C", cwd, "rev-parse", ref], {
    encoding: "utf8",
  });
  if (result.status !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha || undefined;
}

function computePatchId(cwd: string, base: string, head: string): string | undefined {
  // Pipe `git diff` through `git patch-id --stable`. Use sh -c to keep
  // the pipeline atomic and avoid plumbing stdio between two spawns.
  const result = spawnSync(
    "sh",
    ["-c", `git -C ${shellQuote(cwd)} diff ${shellQuote(base)}..${shellQuote(head)} | git patch-id --stable`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const first = result.stdout.split(/\s+/, 1)[0]?.trim();
  return first ? first : undefined;
}

function computeIntegrationTreeId(cwd: string, base: string, head: string): string | undefined {
  const result = spawnSync(
    "git",
    ["-C", cwd, "merge-tree", "--write-tree", "--no-messages", base, head],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  const tree = result.stdout.trim().split(/\s+/, 1)[0];
  return tree || undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
