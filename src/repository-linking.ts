import { existsSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "./types.ts";
import { execCommand } from "./utils.ts";

export function normalizeGitHubRepo(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("GitHub repo is required.");
  }

  const withoutProtocol = trimmed
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/^github\.com\//i, "")
    .replace(/^\/+|\/+$/g, "");

  const parts = withoutProtocol.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid GitHub repo: ${input}`);
  }
  return `${parts[0]}/${parts[1]}`;
}

export function defaultLocalRepoPath(reposRoot: string, githubRepo: string): string {
  const repoName = githubRepo.split("/").pop();
  if (!repoName) {
    throw new Error(`Invalid GitHub repo: ${githubRepo}`);
  }
  return path.join(reposRoot, repoName);
}

export async function ensureLocalRepository(params: {
  config: AppConfig;
  githubRepo: string;
  localPath: string;
}): Promise<{ reused: boolean; localPath: string; originUrl: string }> {
  const githubRepo = normalizeGitHubRepo(params.githubRepo);
  const localPath = path.resolve(params.localPath);
  const originUrl = `https://github.com/${githubRepo}.git`;

  if (!existsSync(localPath)) {
    await execCommand(params.config.runner.gitBin, ["clone", originUrl, localPath], { timeoutMs: 300_000 });
    return { reused: false, localPath, originUrl };
  }

  const remote = await execCommand(params.config.runner.gitBin, ["-C", localPath, "remote", "get-url", "origin"], { timeoutMs: 10_000 });
  const existingRepo = normalizeGitHubRepo(remote.stdout.trim());
  if (existingRepo !== githubRepo) {
    throw new Error(`Existing repo at ${localPath} points to ${existingRepo}, not ${githubRepo}`);
  }

  return { reused: true, localPath, originUrl };
}
