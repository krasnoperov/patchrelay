import type { GitHubAppCredentials } from "./github-auth.ts";
import { issueGitHubAppToken } from "./github-auth.ts";
import type { RequiredCheck } from "./types.ts";

export interface DiscoveredRepoSettings {
  defaultBranch: string;
  branch: string;
  requiredChecks: string[];
  requiredCheckRules: RequiredCheck[];
  requireAllChecksOnEmptyRequiredSet: boolean;
  warnings: string[];
}

interface GitHubRepositoryResponse {
  default_branch?: string;
}

interface GitHubRuleStatusCheck {
  context?: string;
  integration_id?: number | null;
}

interface GitHubRule {
  type?: string;
  parameters?: {
    required_status_checks?: GitHubRuleStatusCheck[];
  };
}

interface GitHubBranchProtectionCheck {
  context?: string;
  app_id?: number | null;
}

interface GitHubBranchProtectionResponse {
  required_status_checks?: {
    strict?: boolean;
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

function requiredCheckKey(check: RequiredCheck): string {
  return `${check.name.trim().toLowerCase()}\u0000${check.appId ?? "*"}`;
}

function mergeRequiredChecks(checks: RequiredCheck[]): RequiredCheck[] {
  const byName = new Map<string, RequiredCheck[]>();
  for (const check of checks) {
    const name = check.name.trim();
    if (!name) continue;
    const normalizedName = name.toLowerCase();
    const list = byName.get(normalizedName) ?? [];
    list.push({ name, appId: check.appId });
    byName.set(normalizedName, list);
  }

  const merged: RequiredCheck[] = [];
  for (const sameName of byName.values()) {
    const appSpecific = sameName.filter((check) => check.appId !== null);
    const selected = appSpecific.length > 0 ? appSpecific : sameName.slice(0, 1);
    for (const check of selected) {
      if (!merged.some((candidate) => requiredCheckKey(candidate) === requiredCheckKey(check))) {
        merged.push(check);
      }
    }
  }
  return merged.sort((left, right) =>
    left.name.localeCompare(right.name) || (left.appId ?? -1) - (right.appId ?? -1));
}

function normalizeRequiredChecks(rules: GitHubRule[]): { requiredCheckRules: RequiredCheck[]; warnings: string[] } {
  const requiredCheckRules: RequiredCheck[] = [];
  const warnings = new Set<string>();

  for (const rule of rules) {
    if (rule.type === "required_status_checks") {
      for (const check of rule.parameters?.required_status_checks ?? []) {
        const context = check.context?.trim();
        if (context) {
          requiredCheckRules.push({
            name: context,
            appId: typeof check.integration_id === "number" ? check.integration_id : null,
          });
        }
      }
    }

    if (rule.type === "workflows") {
      warnings.add("GitHub branch rules require workflows; Steward enforces check-run names from GitHub protection, so workflow names may still need a matching required status check context.");
    }
  }

  return {
    requiredCheckRules: mergeRequiredChecks(requiredCheckRules),
    warnings: [...warnings],
  };
}

function extractProtectionChecks(protection: GitHubBranchProtectionResponse | undefined): RequiredCheck[] {
  if (!protection?.required_status_checks) {
    return [];
  }
  const checks: RequiredCheck[] = [];
  for (const context of protection.required_status_checks.contexts ?? []) {
    const trimmed = context?.trim();
    if (trimmed) {
      checks.push({ name: trimmed, appId: null });
    }
  }
  for (const check of protection.required_status_checks.checks ?? []) {
    const trimmed = check.context?.trim();
    if (trimmed) {
      checks.push({
        name: trimmed,
        appId: typeof check.app_id === "number" ? check.app_id : null,
      });
    }
  }
  return mergeRequiredChecks(checks);
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
  const { requiredCheckRules: ruleChecks, warnings } = normalizeRequiredChecks(parseRulesResponse(rulesResponse));
  const protection = await fetchGitHubJsonOptional<GitHubBranchProtectionResponse>(
    `https://api.github.com/repos/${encodedRepo}/branches/${encodeURIComponent(branch)}/protection`,
    token,
  );
  const protectionChecks = extractProtectionChecks(protection);
  const requireAllChecksOnEmptyRequiredSet = (
    ruleChecks.length === 0
    && protectionChecks.length === 0
    && Boolean(protection?.required_status_checks)
  );
  const requiredCheckRules = mergeRequiredChecks([...ruleChecks, ...protectionChecks]);
  const requiredChecks = [...new Set(requiredCheckRules.map((check) => check.name))]
    .sort((left, right) => left.localeCompare(right));

  if (requiredChecks.length === 0) {
    warnings.push(
      requireAllChecksOnEmptyRequiredSet
        ? `GitHub requires status checks on ${branch} but does not expose explicit contexts; Steward will require all observed checks on the ref to pass until branch protection declares named required checks.`
        : `No required status checks discovered for ${branch}; Steward will treat any green check as sufficient until GitHub branch protection declares explicit required checks.`,
    );
  }

  return {
    defaultBranch,
    branch,
    requiredChecks,
    requiredCheckRules,
    requireAllChecksOnEmptyRequiredSet,
    warnings,
  };
}

export function normalizeCheckList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}
