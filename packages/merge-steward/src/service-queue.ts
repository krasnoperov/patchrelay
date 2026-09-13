import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { StewardConfig } from "./config.ts";
import type { GitHubPolicyCache } from "./github-policy.ts";
import { INVALIDATION_PATCH, selectDownstream } from "./invalidation.ts";
import type { GitHubPRApi, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, QueueEntryStatus } from "./types.ts";
import { evaluateCheckPolicy, formatRequiredCheck } from "./check-policy.ts";

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
    /** A matching parent head branch makes this a stacked queue entry. */
    baseRefName?: string;
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
      candidateKind: null,
      candidatePolicyFingerprint: null,
      candidateRef: null,
      candidateSha: null,
      candidateBasedOn: null,
      waitDetail: null,
      postMergeStatus: null,
      postMergeSha: null,
      postMergeSummary: null,
      postMergeCheckedAt: null,
      prTitle: params.prTitle ?? null,
      baseRefName: params.baseRefName ?? null,
      decidedAt: null,
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
      if (status.headSha !== headSha) {
        this.logger.debug(
          { prNumber, eventHeadSha: headSha, liveHeadSha: status.headSha },
          "Admission wakeup refers to a stale PR head",
        );
        return false;
      }
      if (!status.reviewApproved) {
        this.logger.debug({ prNumber, reviewDecision: status.reviewDecision }, "PR review gate is not satisfied, skipping admission");
        return false;
      }

      // Admission and ordering are derived from review/check/PR truth. Labels
      // remain available for presentation but are not control inputs.
      const priority = 0;

      const checks = await this.github.listChecksForRef(status.headSha);
      const requiredCheckRules = this.policy.getRequiredCheckRules();
      const evaluation = evaluateCheckPolicy(
        requiredCheckRules,
        this.policy.shouldRequireAllChecksOnEmptyRequiredSet(),
        checks,
      );
      if (evaluation.status !== "pass") {
        this.logger.debug(
          {
            prNumber,
            checks: checks.map((check) => `${check.name}:${check.conclusion}`),
            requiredChecks: requiredCheckRules.map(formatRequiredCheck),
            checkPolicyStatus: evaluation.status,
          },
          "Branch checks are not settled green, skipping admission",
        );
        return false;
      }

      // A stacked PR waits for its parent queue entry. Monotonic positions
      // guarantee parent-before-child ordering, not strict adjacency.
      const baseRefName = status.baseRefName ?? null;
      if (baseRefName && baseRefName !== this.config.baseBranch) {
        const parentEntry = this.findActiveEntryByBranch(baseRefName);
        if (!parentEntry) {
          this.logger.debug(
            {
              prNumber,
              baseRefName,
              repoBaseBranch: this.config.baseBranch,
            },
            "Deferring admission for stacked PR — parent branch is not in the queue yet",
          );
          return false;
        }
      }

      this.enqueue({
        prNumber,
        branch,
        headSha,
        priority,
        ...(status.title ? { prTitle: status.title } : {}),
        ...(baseRefName ? { baseRefName } : {}),
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
      if (entry.candidateRef) {
        this.specBuilder.deleteSpeculative(entry.candidateRef).catch(() => {});
      }
      this.store.transition(
        entry.id,
        "superseded",
        {
          candidateKind: null,
          candidatePolicyFingerprint: null,
          candidateRef: null,
          candidateSha: null,
          candidateBasedOn: null,
          ciRunId: null,
          ciRetries: 0,
          waitDetail: null,
        },
        `admitted head ${entry.headSha.slice(0, 12)} superseded by ${headSha.slice(0, 12)}; new head must pass admission`,
      );
      this.invalidateDownstreamOf(entry);
      this.clearQueueStateLabels(prNumber).catch(() => {});
      this.logger.info({ prNumber, entryId: entry.id, previousHeadSha: entry.headSha, headSha }, "PR head changed; admission revoked");
    }
  }

  async acknowledgeExternalMerge(prNumber: number): Promise<void> {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.transition(entry.id, "merged" as QueueEntryStatus, {
        postMergeStatus: "pending",
        postMergeSha: entry.headSha,
        postMergeSummary: "external merge detected, verification pending",
        postMergeCheckedAt: new Date().toISOString(),
      });
      this.invalidateDownstreamOf(entry);
      await this.clearQueueStateLabels(prNumber);
      this.logger.info({ prNumber, entryId: entry.id }, "External merge acknowledged");
    }
  }

  private async clearQueueStateLabels(prNumber: number): Promise<void> {
    const managed = [this.config.queueTestingLabel, this.config.queueMergingLabel].filter(Boolean);
    if (managed.length === 0) return;

    let current: string[];
    try {
      current = await this.github.listLabels(prNumber);
    } catch (error) {
      this.logger.debug({ prNumber, err: error }, "Could not read queue state labels after external merge");
      return;
    }

    const remove = managed.filter((label) => current.includes(label));
    if (remove.length === 0) return;

    try {
      await this.github.setLabels(prNumber, { remove });
    } catch (error) {
      this.logger.warn({ prNumber, labels: remove, err: error }, "Could not clear queue state labels after external merge");
    }
  }

  private invalidateDownstreamOf(removedEntry: QueueEntry): void {
    const allActive = this.store.listActive(this.config.repoId);
    const targets = selectDownstream(allActive, removedEntry.id);
    for (const downstream of targets) {
      if (downstream.candidateRef) {
        this.specBuilder.deleteSpeculative(downstream.candidateRef).catch(() => {});
      }
      this.store.transition(downstream.id, "preparing_head", INVALIDATION_PATCH,
        `invalidated: entry ${removedEntry.id.slice(0, 8)} left the train`);
    }
    if (targets.length > 0) {
      this.logger.info({ removedEntryId: removedEntry.id, invalidated: targets.length }, "Invalidated downstream entries after train removal");
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
      if (affected.candidateRef) {
        this.specBuilder.deleteSpeculative(affected.candidateRef).catch(() => {});
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

  // Find the active entry whose head branch matches `name`.
  private findActiveEntryByBranch(name: string): QueueEntry | undefined {
    return this.store.listActive(this.config.repoId).find((entry) => entry.branch === name);
  }
}
