import { spawnSync } from "node:child_process";
import type { ReviewQuillRepositoryConfig } from "../types.ts";
import { defaultDiffRepoConfig } from "../diff-context/index.ts";

export interface GhBranchProtectionResponse {
  required_status_checks?: {
    contexts?: string[];
    checks?: Array<{ context?: string }>;
  };
}

export interface GhRepoResponse {
  default_branch?: string;
}

export interface GhReviewGateResponse {
  data?: {
    repository?: {
      pullRequests?: {
        nodes?: Array<{
          number?: number;
          reviewDecision?: string;
          headRefOid?: string;
          latestReviews?: {
            nodes?: Array<{
              state?: string;
              author?: { login?: string };
              authorCanPushToRepository?: boolean;
              commit?: { oid?: string };
            }>;
          };
        }>;
      };
    };
  };
}

function defaultGhCommand(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function runGhApiJson<T>(pathArg: string): T {
  const result = defaultGhCommand(["api", pathArg]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `gh api ${pathArg} failed`);
  }
  return JSON.parse(result.stdout) as T;
}

export function runGhGraphqlJson<T>(query: string, variables: Record<string, string>): T {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    args.push("-f", `${name}=${value}`);
  }
  const result = defaultGhCommand(args);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "gh api graphql failed");
  }
  return JSON.parse(result.stdout) as T;
}

function splitRepoFullName(repoFullName: string): { owner: string; name: string } {
  const [owner, name] = repoFullName.split("/", 2);
  if (!owner || !name) {
    throw new Error(`Invalid GitHub repository name: ${repoFullName}`);
  }
  return { owner, name };
}

export function discoverRepoSettingsViaGhCli(repoFullName: string, branch?: string): {
  defaultBranch: string;
  branch: string;
  requiredChecks: string[];
} {
  const repo = runGhApiJson<GhRepoResponse>(`repos/${repoFullName}`);
  const targetBranch = branch?.trim() || repo.default_branch?.trim() || "main";
  const requiredChecks = new Set<string>();
  try {
    const protection = runGhApiJson<GhBranchProtectionResponse>(`repos/${repoFullName}/branches/${targetBranch}/protection`);
    for (const context of protection.required_status_checks?.contexts ?? []) {
      const trimmed = context?.trim();
      if (trimmed) requiredChecks.add(trimmed);
    }
    for (const check of protection.required_status_checks?.checks ?? []) {
      const trimmed = check.context?.trim();
      if (trimmed) requiredChecks.add(trimmed);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("404")) {
      throw error;
    }
  }

  return {
    defaultBranch: repo.default_branch?.trim() || targetBranch,
    branch: targetBranch,
    requiredChecks: [...requiredChecks].sort((left, right) => left.localeCompare(right)),
  };
}

export function queryReviewGateState(repoFullName: string): GhReviewGateResponse {
  const { owner, name } = splitRepoFullName(repoFullName);
  return runGhGraphqlJson<GhReviewGateResponse>(
    `query($owner:String!, $name:String!) {
      repository(owner:$owner, name:$name) {
        pullRequests(first:20, states:OPEN, orderBy:{field:UPDATED_AT, direction:DESC}) {
          nodes {
            number
            reviewDecision
            headRefOid
            latestReviews(first:20) {
              nodes {
                state
                author { login }
                authorCanPushToRepository
                commit { oid }
              }
            }
          }
        }
      }
    }`,
    { owner, name },
  );
}
