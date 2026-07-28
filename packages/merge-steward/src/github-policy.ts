import type { Logger } from "pino";
import { createHash } from "node:crypto";
import type { DiscoveredRepoSettings } from "./github-repo-discovery.ts";
import type { RequiredCheck } from "./types.ts";

export interface GitHubPolicySnapshot {
  requiredChecks: string[];
  requiredCheckRules: RequiredCheck[];
  requireAllChecksOnEmptyRequiredSet: boolean;
  fetchedAt: string | null;
  lastRefreshReason: string | null;
  lastRefreshChanged: boolean | null;
}

export interface GitHubPolicyRefreshResult {
  attempted: boolean;
  changed: boolean;
  previousRequiredChecks: string[];
  requiredChecks: string[];
  requireAllChecksOnEmptyRequiredSet: boolean;
  fetchedAt: string | null;
  skippedReason?: string | undefined;
}

interface GitHubPolicyCacheOptions {
  repoFullName: string;
  initialRequiredChecks: string[];
  initialRequiredCheckRules?: RequiredCheck[];
  initialRequireAllChecksOnEmptyRequiredSet?: boolean;
  logger: Logger;
  refreshPolicy(): Promise<DiscoveredRepoSettings>;
  issueRefreshCooldownMs?: number;
}

function normalizeChecks(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function equalChecks(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function normalizeCheckRules(values: RequiredCheck[]): RequiredCheck[] {
  const deduped = new Map<string, RequiredCheck>();
  for (const value of values) {
    const name = value.name.trim();
    if (!name) continue;
    const appId = value.appId ?? null;
    deduped.set(`${name.toLowerCase()}\u0000${appId ?? "*"}`, { name, appId });
  }
  return [...deduped.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || (left.appId ?? -1) - (right.appId ?? -1));
}

function equalCheckRules(left: RequiredCheck[], right: RequiredCheck[]): boolean {
  return left.length === right.length
    && left.every((value, index) =>
      value.name === right[index]?.name && value.appId === right[index]?.appId);
}

export class GitHubPolicyCache {
  private requiredChecks: string[];
  private requiredCheckRules: RequiredCheck[];
  private requireAllChecksOnEmptyRequiredSet: boolean;
  private fetchedAt: string | null;
  private lastIssueRefreshAt = 0;
  private readonly issueRefreshCooldownMs: number;
  private lastRefreshReason: string | null = null;
  private lastRefreshChanged: boolean | null = null;

  constructor(private readonly options: GitHubPolicyCacheOptions) {
    this.requiredChecks = normalizeChecks(options.initialRequiredChecks);
    this.requiredCheckRules = normalizeCheckRules(
      options.initialRequiredCheckRules
        ?? this.requiredChecks.map((name) => ({ name, appId: null })),
    );
    this.requireAllChecksOnEmptyRequiredSet = options.initialRequireAllChecksOnEmptyRequiredSet ?? false;
    this.fetchedAt = new Date().toISOString();
    this.issueRefreshCooldownMs = options.issueRefreshCooldownMs ?? 5 * 60_000;
  }

  getSnapshot(): GitHubPolicySnapshot {
    return {
      requiredChecks: [...this.requiredChecks],
      requiredCheckRules: this.requiredCheckRules.map((check) => ({ ...check })),
      requireAllChecksOnEmptyRequiredSet: this.requireAllChecksOnEmptyRequiredSet,
      fetchedAt: this.fetchedAt,
      lastRefreshReason: this.lastRefreshReason,
      lastRefreshChanged: this.lastRefreshChanged,
    };
  }

  getRequiredChecks(): string[] {
    return [...this.requiredChecks];
  }

  getRequiredCheckRules(): RequiredCheck[] {
    return this.requiredCheckRules.map((check) => ({ ...check }));
  }

  getFingerprint(): string {
    return createHash("sha256").update(JSON.stringify({
      requiredChecks: this.requiredCheckRules,
      requireAllChecksOnEmptyRequiredSet: this.requireAllChecksOnEmptyRequiredSet,
    })).digest("hex");
  }

  shouldRequireAllChecksOnEmptyRequiredSet(): boolean {
    return this.requireAllChecksOnEmptyRequiredSet;
  }

  async refreshFromWebhook(reason: string): Promise<GitHubPolicyRefreshResult> {
    return await this.refresh(reason, { force: true, issueTriggered: false });
  }

  async refreshBeforeLanding(reason: string): Promise<GitHubPolicyRefreshResult> {
    return await this.refresh(reason, { force: true, issueTriggered: false });
  }

  async refreshOnIssue(reason: string): Promise<GitHubPolicyRefreshResult> {
    const now = Date.now();
    if (now - this.lastIssueRefreshAt < this.issueRefreshCooldownMs) {
      return {
        attempted: false,
        changed: false,
        previousRequiredChecks: [...this.requiredChecks],
        requiredChecks: [...this.requiredChecks],
        requireAllChecksOnEmptyRequiredSet: this.requireAllChecksOnEmptyRequiredSet,
        fetchedAt: this.fetchedAt,
        skippedReason: "cooldown",
      };
    }
    this.lastIssueRefreshAt = now;
    return await this.refresh(reason, { force: false, issueTriggered: true });
  }

  private async refresh(
    reason: string,
    options: { force: boolean; issueTriggered: boolean },
  ): Promise<GitHubPolicyRefreshResult> {
    const previousRequiredChecks = [...this.requiredChecks];
    const previousRequireAllChecksOnEmptyRequiredSet = this.requireAllChecksOnEmptyRequiredSet;
    const previousRequiredCheckRules = this.requiredCheckRules;
    const discovered = await this.options.refreshPolicy();
    const nextRequiredChecks = normalizeChecks(discovered.requiredChecks);
    const nextRequiredCheckRules = normalizeCheckRules(
      discovered.requiredCheckRules
        ?? nextRequiredChecks.map((name) => ({ name, appId: null })),
    );
    const changed = !equalChecks(previousRequiredChecks, nextRequiredChecks)
      || !equalCheckRules(previousRequiredCheckRules, nextRequiredCheckRules)
      || previousRequireAllChecksOnEmptyRequiredSet !== discovered.requireAllChecksOnEmptyRequiredSet;
    this.requiredChecks = nextRequiredChecks;
    this.requiredCheckRules = nextRequiredCheckRules;
    this.requireAllChecksOnEmptyRequiredSet = discovered.requireAllChecksOnEmptyRequiredSet;
    this.fetchedAt = new Date().toISOString();
    this.lastRefreshReason = reason;
    this.lastRefreshChanged = changed;

    this.options.logger.info({
      repoFullName: this.options.repoFullName,
      reason,
      changed,
      requiredChecks: this.requiredChecks,
      requireAllChecksOnEmptyRequiredSet: this.requireAllChecksOnEmptyRequiredSet,
      policyRefreshSource: options.issueTriggered ? "issue" : (options.force ? "webhook" : "manual"),
    }, "Refreshed GitHub protection policy");

    return {
      attempted: true,
      changed,
      previousRequiredChecks,
      requiredChecks: [...this.requiredChecks],
      requireAllChecksOnEmptyRequiredSet: this.requireAllChecksOnEmptyRequiredSet,
      fetchedAt: this.fetchedAt,
    };
  }
}
