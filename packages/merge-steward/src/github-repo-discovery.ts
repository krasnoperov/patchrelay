import type { GitHubAppCredentials } from "./github-auth.ts";
import { issueGitHubAppToken } from "./github-auth.ts";

export interface DiscoveredRepoSettings {
  defaultBranch: string;
  branch: string;
  requiredChecks: string[];
  warnings: string[];
}

interface GitHubRepositoryResponse {
  default_branch?: string;
}

interface GitHubRuleStatusCheck {
  context?: string;
}

interface GitHubRule {
  type?: string;
  parameters?: {
    required_status_checks?: GitHubRuleStatusCheck[];
  };
}

interface GitHubBranchProtectionCheck {
  context?: string;
}

interface GitHubBranchProtectionResponse {
  required_status_checks?: {
    contexts?: string[];
    checks?: GitHubBranchProtectionCheck[];
  };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchGitHubJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: githubHeaders(token),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
  }
  return await response.json() as T;
}

async function fetchGitHubJsonOptional<T>(url: string, token: string): Promise<T | undefined> {
  const response = await fetch(url, {
    headers: githubHeaders(token),
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${url}: ${body}`);
  }
  return await response.json() as T;
}

function parseRulesResponse(raw: unknown): GitHubRule[] {
  if (Array.isArray(raw)) {
    return raw as GitHubRule[];
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules)) {
    return (raw as { rules: GitHubRule[] }).rules;
  }
  return [];
}

function normalizeRequiredChecks(rules: GitHubRule[]): { requiredChecks: string[]; warnings: string[] } {
  const requiredChecks = new Set<string>();
  const warnings = new Set<string>();

  for (const rule of rules) {
    if (rule.type === "required_status_checks") {
      for (const check of rule.parameters?.required_status_checks ?? []) {
        const context = check.context?.trim();
        if (context) {
          requiredChecks.add(context);
        }
      }
    }

    if (rule.type === "workflows") {
      warnings.add("GitHub branch rules require workflows; Steward still needs explicit requiredChecks if workflow names differ from check-run names.");
    }
  }

  return {
    requiredChecks: [...requiredChecks].sort((left, right) => left.localeCompare(right)),
    warnings: [...warnings],
  };
}

function extractProtectionChecks(protection: GitHubBranchProtectionResponse | undefined): string[] {
  if (!protection?.required_status_checks) {
    return [];
  }
  const checks = new Set<string>();
  for (const context of protection.required_status_checks.contexts ?? []) {
    const trimmed = context?.trim();
    if (trimmed) {
      checks.add(trimmed);
    }
  }
  for (const check of protection.required_status_checks.checks ?? []) {
    const trimmed = check.context?.trim();
    if (trimmed) {
      checks.add(trimmed);
    }
  }
  return [...checks].sort((left, right) => left.localeCompare(right));
}

export async function discoverRepoSettings(
  credentials: GitHubAppCredentials,
  repoFullName: string,
  options?: { baseBranch?: string },
): Promise<DiscoveredRepoSettings> {
  const { token } = await issueGitHubAppToken(credentials, { repoFullName });
  const encodedRepo = repoFullName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  const repository = await fetchGitHubJson<GitHubRepositoryResponse>(
    `https://api.github.com/repos/${encodedRepo}`,
    token,
  );
  const defaultBranch = repository.default_branch?.trim();
  if (!defaultBranch) {
    throw new Error(`GitHub repository ${repoFullName} did not return a default branch.`);
  }

  const branch = options?.baseBranch?.trim() || defaultBranch;
  const rulesResponse = await fetchGitHubJson<unknown>(
    `https://api.github.com/repos/${encodedRepo}/rules/branches/${encodeURIComponent(branch)}`,
    token,
  );
  const { requiredChecks: ruleChecks, warnings } = normalizeRequiredChecks(parseRulesResponse(rulesResponse));
  const protection = await fetchGitHubJsonOptional<GitHubBranchProtectionResponse>(
    `https://api.github.com/repos/${encodedRepo}/branches/${encodeURIComponent(branch)}/protection`,
    token,
  );
  const protectionChecks = extractProtectionChecks(protection);
  const requiredChecks = [...new Set([...ruleChecks, ...protectionChecks])].sort((left, right) => left.localeCompare(right));

  if (requiredChecks.length === 0) {
    warnings.push(`No required status checks discovered for ${branch}; Steward will admit on any green check unless you configure requiredChecks explicitly.`);
  }

  return {
    defaultBranch,
    branch,
    requiredChecks,
    warnings,
  };
}

export function normalizeCheckList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
