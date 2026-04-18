import type { Logger } from "pino";
import type { DiscoveredRepoSettings } from "./github-repo-discovery.ts";

export interface GitHubPolicySnapshot {
  requiredChecks: string[];
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

export class GitHubPolicyCache {
  private requiredChecks: string[];
  private requireAllChecksOnEmptyRequiredSet: boolean;
  private fetchedAt: string | null;
  private lastIssueRefreshAt = 0;
  private readonly issueRefreshCooldownMs: number;
  private lastRefreshReason: string | null = null;
  private lastRefreshChanged: boolean | null = null;

  constructor(private readonly options: GitHubPolicyCacheOptions) {
    this.requiredChecks = normalizeChecks(options.initialRequiredChecks);
    this.requireAllChecksOnEmptyRequiredSet = options.initialRequireAllChecksOnEmptyRequiredSet ?? false;
    this.fetchedAt = new Date().toISOString();
    this.issueRefreshCooldownMs = options.issueRefreshCooldownMs ?? 5 * 60_000;
  }

  getSnapshot(): GitHubPolicySnapshot {
    return {
      requiredChecks: [...this.requiredChecks],
      requireAllChecksOnEmptyRequiredSet: this.requireAllChecksOnEmptyRequiredSet,
      fetchedAt: this.fetchedAt,
      lastRefreshReason: this.lastRefreshReason,
      lastRefreshChanged: this.lastRefreshChanged,
    };
  }

  getRequiredChecks(): string[] {
    return [...this.requiredChecks];
  }

  shouldRequireAllChecksOnEmptyRequiredSet(): boolean {
    return this.requireAllChecksOnEmptyRequiredSet;
  }

  async refreshFromWebhook(reason: string): Promise<GitHubPolicyRefreshResult> {
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
    const discovered = await this.options.refreshPolicy();
    const nextRequiredChecks = normalizeChecks(discovered.requiredChecks);
    const changed = !equalChecks(previousRequiredChecks, nextRequiredChecks)
      || previousRequireAllChecksOnEmptyRequiredSet !== discovered.requireAllChecksOnEmptyRequiredSet;
    this.requiredChecks = nextRequiredChecks;
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
