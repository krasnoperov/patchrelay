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
      postMergeStatus: null,
      postMergeSha: null,
      postMergeSummary: null,
      postMergeCheckedAt: null,
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

    try {
      const status = await this.github.getStatus(prNumber);
      if (!status.reviewApproved) {
        this.logger.debug({ prNumber, reviewDecision: status.reviewDecision }, "PR review gate is not satisfied, skipping admission");
        return false;
      }

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
      } else {
        const nonSteward = checks.filter((c) => !c.name.startsWith("merge-steward"));
        const hasGreen = nonSteward.some((c) => c.conclusion === "success");
        if (!hasGreen) {
          this.logger.debug({ prNumber }, "No green CI checks, skipping admission");
          return false;
        }
      }

      this.enqueue({ prNumber, branch, headSha });
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
    const targets = selectDownstream(allActive, removedEntry.position);
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
