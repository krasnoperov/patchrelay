import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { StewardConfig } from "./config.ts";
import type { GitHubPolicyCache } from "./github-policy.ts";
import { INVALIDATION_PATCH, selectDownstream } from "./invalidation.ts";
import type { GitHubPRApi, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, QueueEntryStatus } from "./types.ts";

function normalizeCheckName(name: string): string {
  return name.trim().toLowerCase();
}

function matchGlob(pattern: string, value: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return regex.test(value);
}

function getLatestEvictedEntry(entries: QueueEntry[], prNumber: number): QueueEntry | undefined {
  const evicted = entries.filter((entry) => entry.prNumber === prNumber && entry.status === "evicted");
  evicted.sort((left, right) => {
    const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    if (updatedDelta !== 0) return updatedDelta;
    return right.position - left.position;
  });
  return evicted[0];
}

export class MergeStewardQueueCommands {
  constructor(
    private readonly config: StewardConfig,
    private readonly policy: GitHubPolicyCache,
    private readonly store: QueueStore,
    private readonly github: GitHubPRApi,
    private readonly specBuilder: SpeculativeBranchBuilder,
    private readonly logger: Logger,
  ) {}

  enqueue(params: {
    prNumber: number;
    branch: string;
    headSha: string;
    issueKey?: string;
    priority?: number;
    prTitle?: string;
  }): QueueEntry | undefined {
    const existing = this.store.getEntryByPR(this.config.repoId, params.prNumber);
    if (existing) {
      this.logger.warn(
        { prNumber: params.prNumber, existingEntryId: existing.id },
        "Duplicate enqueue rejected: active entry already exists for PR",
      );
      return existing;
    }

    const entry: QueueEntry = {
      id: randomUUID(),
      repoId: this.config.repoId,
      prNumber: params.prNumber,
      branch: params.branch,
      headSha: params.headSha,
      baseSha: "",
      status: "queued",
      position: this.nextPosition(),
      priority: params.priority ?? 0,
      generation: 0,
      ciRunId: null,
      ciRetries: 0,
      retryAttempts: 0,
      maxRetries: this.config.maxRetries,
      lastFailedBaseSha: null,
      issueKey: params.issueKey ?? null,
      specBranch: null,
      specSha: null,
      specBasedOn: null,
      waitDetail: null,
      postMergeStatus: null,
      postMergeSha: null,
      postMergeSummary: null,
      postMergeCheckedAt: null,
      prTitle: params.prTitle ?? null,
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      this.store.insert(entry);
    } catch (error) {
      const raced = this.store.getEntryByPR(this.config.repoId, params.prNumber);
      if (raced) {
        this.logger.warn(
          { prNumber: params.prNumber, existingEntryId: raced.id },
          "Duplicate enqueue caught by constraint: returning existing entry",
        );
        return raced;
      }
      throw error;
    }

    this.logger.info({ prNumber: params.prNumber, entryId: entry.id }, "PR enqueued");
    if (entry.priority > 0) {
      this.invalidateDownstreamOf(entry);
    }
    return entry;
  }

  async scanStartupAdmissions(): Promise<void> {
    this.logger.info({ repoId: this.config.repoId }, "Scanning startup admissions");
    try {
      const { scanned, admitted } = await this.scanEligibleOpenPrs();
      if (scanned > 0) {
        this.logger.info({ scanned, admitted }, "Startup scan for eligible open PRs complete");
      }
    } catch (error) {
      this.logger.warn({ err: error }, "Startup scan for eligible open PRs failed");
    }
  }

  async scanEligibleOpenPrs(): Promise<{ scanned: number; admitted: number }> {
    const open = await this.github.listOpenPRs();
    let admitted = 0;
    for (const pr of open) {
      if (await this.tryAdmit(pr.number, pr.branch, pr.headSha)) admitted += 1;
    }
    return { scanned: open.length, admitted };
  }

  updatePriorityByPR(prNumber: number, priority: number): boolean {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (!entry) {
      return false;
    }
    if (entry.priority === priority) {
      return true;
    }

    const before = this.store.listActive(this.config.repoId);
    this.store.updatePriority(entry.id, priority, `priority lane ${priority > 0 ? "enabled" : "disabled"}`);
    const after = this.store.listActive(this.config.repoId);
    const affected = this.findAffectedEntriesAfterPriorityChange(before, after);
    this.requeueAffectedEntries(affected, `priority changed for entry ${entry.id.slice(0, 8)}`);
    this.logger.info({ prNumber, entryId: entry.id, priority }, "Updated queued PR priority");
    return true;
  }

  async tryAdmit(prNumber: number, branch: string, headSha: string): Promise<boolean> {
    if (this.config.excludeBranches.some((pattern) => matchGlob(pattern, branch))) {
      this.logger.debug({ prNumber, branch }, "Branch excluded from admission");
      return false;
    }

    const existing = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (existing) {
      this.logger.debug({ prNumber }, "PR already queued, skipping admission");
      return false;
    }

    const latestEvicted = getLatestEvictedEntry(this.store.listAll(this.config.repoId), prNumber);
    if (latestEvicted?.headSha === headSha) {
      this.logger.debug(
        { prNumber, headSha, evictedEntryId: latestEvicted.id },
        "PR head matches latest evicted entry, skipping admission until a new push",
      );
      return false;
    }

    try {
      const status = await this.github.getStatus(prNumber);
      if (!status.reviewApproved) {
        this.logger.debug({ prNumber, reviewDecision: status.reviewDecision }, "PR review gate is not satisfied, skipping admission");
        return false;
      }

      const labels = await this.github.listLabels(prNumber);
      const priority = labels.includes(this.config.priorityQueueLabel) ? 1 : 0;

      const checks = await this.github.listChecks(prNumber);
      const requiredChecks = this.policy.getRequiredChecks();
      if (requiredChecks.length > 0) {
        const required = new Set(requiredChecks.map(normalizeCheckName));
        const passing = checks.filter((c) => c.conclusion === "success" && required.has(normalizeCheckName(c.name)));
        if (passing.length < required.size) {
          this.logger.debug(
            {
              prNumber,
              passing: passing.length,
              required: required.size,
              checkNames: checks.map((check) => check.name),
              requiredChecks,
            },
            "Required checks not all green",
          );
          return false;
        }
      } else if (this.policy.shouldRequireAllChecksOnEmptyRequiredSet()) {
        if (checks.length === 0) {
          this.logger.debug({ prNumber }, "GitHub requires checks but none are visible yet, skipping admission");
          return false;
        }
        const hasPending = checks.some((check) => check.conclusion === "pending");
        const hasFailures = checks.some((check) => check.conclusion === "failure");
        if (hasPending || hasFailures) {
          this.logger.debug(
            {
              prNumber,
              checkNames: checks.map((check) => `${check.name}:${check.conclusion}`),
            },
            "GitHub requires all observed checks to pass before admission",
          );
          return false;
        }
      } else {
        const nonSteward = checks.filter((c) => !c.name.startsWith("merge-steward"));
        const hasGreen = nonSteward.some((c) => c.conclusion === "success");
        if (!hasGreen) {
          this.logger.debug({ prNumber }, "No green CI checks, skipping admission");
          return false;
        }
      }

      this.enqueue({
        prNumber,
        branch,
        headSha,
        priority,
        ...(status.title ? { prTitle: status.title } : {}),
      });
      return true;
    } catch (error) {
      this.logger.warn({ prNumber, err: error }, "Failed to check admission eligibility");
      return false;
    }
  }

  dequeueByPR(prNumber: number): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.dequeue(entry.id);
      this.invalidateDownstreamOf(entry);
      this.logger.info({ prNumber, entryId: entry.id }, "PR dequeued");
    }
  }

  updateHeadByPR(prNumber: number, headSha: string): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      if (entry.headSha === headSha) {
        this.logger.debug({ prNumber, entryId: entry.id, headSha }, "Ignoring synchronize webhook for unchanged head");
        return;
      }
      this.store.updateHead(entry.id, headSha);
      this.logger.info({ prNumber, entryId: entry.id, headSha }, "PR head updated via webhook");
    }
  }

  acknowledgeExternalMerge(prNumber: number): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.transition(entry.id, "merged" as QueueEntryStatus, {
        postMergeStatus: "pending",
        postMergeSha: entry.headSha,
        postMergeSummary: "external merge detected, verification pending",
        postMergeCheckedAt: new Date().toISOString(),
      });
      this.invalidateDownstreamOf(entry);
      this.logger.info({ prNumber, entryId: entry.id }, "External merge acknowledged");
    }
  }

  private invalidateDownstreamOf(removedEntry: QueueEntry): void {
    const allActive = this.store.listActive(this.config.repoId);
    const targets = selectDownstream(allActive, removedEntry.id);
    for (const downstream of targets) {
      if (downstream.specBranch) {
        this.specBuilder.deleteSpeculative(downstream.specBranch).catch(() => {});
      }
      this.store.transition(downstream.id, "preparing_head", INVALIDATION_PATCH,
        `invalidated: entry ${removedEntry.id.slice(0, 8)} dequeued`);
    }
    if (targets.length > 0) {
      this.logger.info({ removedEntryId: removedEntry.id, invalidated: targets.length }, "Invalidated downstream entries after dequeue");
    }
  }

  private findAffectedEntriesAfterPriorityChange(before: QueueEntry[], after: QueueEntry[]): QueueEntry[] {
    const maxLength = Math.max(before.length, after.length);
    let firstChangedIndex = -1;
    for (let index = 0; index < maxLength; index += 1) {
      if (before[index]?.id !== after[index]?.id) {
        firstChangedIndex = index;
        break;
      }
    }
    if (firstChangedIndex < 0) {
      return [];
    }
    return after.slice(firstChangedIndex);
  }

  private requeueAffectedEntries(entries: QueueEntry[], reason: string): void {
    for (const affected of entries) {
      if (affected.specBranch) {
        this.specBuilder.deleteSpeculative(affected.specBranch).catch(() => {});
      }
      this.store.transition(affected.id, "queued", INVALIDATION_PATCH, reason);
    }
    if (entries.length > 0) {
      this.logger.info({ affectedEntries: entries.length, reason }, "Requeued affected entries after priority change");
    }
  }

  private nextPosition(): number {
    const existing = this.store.listAll(this.config.repoId);
    let next = 1;
    for (const entry of existing) {
      if (entry.position >= next) {
        next = entry.position + 1;
      }
    }
    return next;
  }
}
