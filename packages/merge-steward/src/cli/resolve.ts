import { spawnSync } from "node:child_process";
import { listRepoConfigs } from "./system.ts";
import type { ParsedArgs, HelpTopic } from "./types.ts";
import { UsageError } from "./types.ts";

export interface ResolveCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ResolveCommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<ResolveCommandResult>;

export function defaultResolveRunner(
  command: string,
  args: string[],
  options?: { cwd?: string },
): Promise<ResolveCommandResult> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
  return Promise.resolve({
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
}

export type RepoRefSource = "flag" | "cwd";

export interface ResolvedRepo {
  repoId: string;
  repoFullName: string;
  source: RepoRefSource;
}

function parseOwnerRepoFromRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return undefined;
  const sshMatch = trimmed.match(/^git@[^:]+:([^/]+\/[^.]+?)(?:\.git)?$/);
  if (sshMatch?.[1]) return sshMatch[1];
  const httpsMatch = trimmed.match(/^https?:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch?.[1]) return httpsMatch[1];
  const sshProto = trimmed.match(/^ssh:\/\/[^/]+\/([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshProto?.[1]) return sshProto[1];
  return undefined;
}

async function resolveGitRemote(runCommand: ResolveCommandRunner, cwd: string): Promise<string | undefined> {
  const result = await runCommand("git", ["remote", "get-url", "origin"], { cwd });
  if (result.exitCode !== 0) return undefined;
  return parseOwnerRepoFromRemote(result.stdout);
}

export interface ResolveOptions {
  parsed: ParsedArgs;
  runCommand?: ResolveCommandRunner;
  cwd?: string;
  helpTopic?: HelpTopic;
}

export async function resolveRepo(options: ResolveOptions): Promise<ResolvedRepo> {
  const parsed = options.parsed;
  const helpTopic = options.helpTopic ?? "root";
  const runCommand = options.runCommand ?? defaultResolveRunner;
  const cwd = options.cwd ?? (typeof parsed.flags.get("cwd") === "string" ? String(parsed.flags.get("cwd")) : process.cwd());

  const flagValue = parsed.flags.get("repo");
  const flagString = typeof flagValue === "string" ? flagValue.trim() : "";
  if (flagString) {
    const match = findAttachedRepo(flagString);
    if (!match) {
      throw new UsageError(attachHint(flagString), helpTopic);
    }
    return { repoId: match.repoId, repoFullName: match.repoFullName, source: "flag" };
  }

  const ownerRepo = await resolveGitRemote(runCommand, cwd);
  if (!ownerRepo) {
    throw new UsageError(
      "Unable to resolve a repo: pass --repo <id> or run from a git checkout with an origin remote.",
      helpTopic,
    );
  }

  const match = findAttachedRepo(ownerRepo);
  if (!match) {
    throw new UsageError(attachHint(ownerRepo), helpTopic);
  }
  return { repoId: match.repoId, repoFullName: match.repoFullName, source: "cwd" };
}

function findAttachedRepo(ref: string): { repoId: string; repoFullName: string } | undefined {
  const normalized = ref.trim();
  if (!normalized) return undefined;
  const lower = normalized.toLowerCase();
  return listRepoConfigs().find(
    (repo) =>
      repo.repoId === normalized
      || repo.repoFullName === normalized
      || repo.repoFullName.toLowerCase() === lower,
  );
}

function attachHint(ref: string): string {
  const attached = listRepoConfigs();
  const attachedHint = attached.length > 0
    ? ` Attached repos: ${attached.map((r) => r.repoId).join(", ")}.`
    : "";
  return `Repo ${ref} is not attached to merge-steward. Run \`merge-steward repo attach ${ref}\` first.${attachedHint}`;
}

export type PrRefSource = "flag" | "cwd";

export interface ResolvedPr {
  prNumber: number;
  source: PrRefSource;
}

export async function resolvePrNumber(options: ResolveOptions): Promise<ResolvedPr> {
  const parsed = options.parsed;
  const helpTopic = options.helpTopic ?? "root";
  const runCommand = options.runCommand ?? defaultResolveRunner;
  const cwd = options.cwd ?? (typeof parsed.flags.get("cwd") === "string" ? String(parsed.flags.get("cwd")) : process.cwd());

  const flagValue = parsed.flags.get("pr");
  if (typeof flagValue === "string" && flagValue.trim()) {
    const flagNumber = parseInt(flagValue.trim(), 10);
    if (!Number.isFinite(flagNumber) || flagNumber <= 0) {
      throw new UsageError("--pr must be a positive integer.", helpTopic);
    }
    return { prNumber: flagNumber, source: "flag" };
  }

  const result = await runCommand("gh", ["pr", "view", "--json", "number", "-q", ".number"], { cwd });
  if (result.exitCode !== 0) {
    const hint = result.stderr.trim() || "no PR for the current branch";
    throw new UsageError(
      `Unable to resolve PR from cwd (${hint}). Pass --pr <number>.`,
      helpTopic,
    );
  }
  const raw = result.stdout.trim();
  const prNumber = parseInt(raw, 10);
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new UsageError(
      `\`gh pr view\` returned no PR number (got: ${JSON.stringify(raw)}). Pass --pr <number>.`,
      helpTopic,
    );
  }
  return { prNumber, source: "cwd" };
}
