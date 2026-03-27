import type { Logger } from "pino";
import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type { QueueEntry, IncidentRecord } from "./types.ts";
import type { StewardConfig } from "./config.ts";
import { reconcile } from "./reconciler.ts";
import { randomUUID } from "node:crypto";

/**
 * Merge steward service. Runs a timer-driven reconciliation loop and
 * exposes methods for the HTTP API to call.
 */
export class MergeStewardService {
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private tickInProgress = false;
  private nextPosition = 1;

  constructor(
    private readonly config: StewardConfig,
    private readonly store: QueueStore,
    private readonly git: GitOperations,
    private readonly ci: CIRunner,
    private readonly github: GitHubPRApi,
    private readonly eviction: EvictionReporter,
    private readonly logger: Logger,
  ) {
    const existing = store.listAll(config.repoId);
    for (const e of existing) {
      if (e.position >= this.nextPosition) {
        this.nextPosition = e.position + 1;
      }
    }
  }

  start(): void {
    this.logger.info({ pollIntervalMs: this.config.pollIntervalMs }, "Steward service starting");
    this.scheduleNextTick();
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = undefined;
    }
    const deadline = Date.now() + 10_000;
    while (this.tickInProgress && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.logger.info("Steward service stopped");
  }

  enqueue(params: {
    prNumber: number;
    branch: string;
    headSha: string;
    issueKey?: string;
    worktreePath?: string;
    priority?: number;
  }): QueueEntry {
    const entry: QueueEntry = {
      id: randomUUID(),
      repoId: this.config.repoId,
      prNumber: params.prNumber,
      branch: params.branch,
      headSha: params.headSha,
      baseSha: "",
      status: "queued",
      position: this.nextPosition++,
      priority: params.priority ?? 0,
      generation: 0,
      ciRunId: null,
      ciRetries: 0,
      retryAttempts: 0,
      maxRetries: this.config.maxRetries,
      lastFailedBaseSha: null,
      issueKey: params.issueKey ?? null,
      worktreePath: params.worktreePath ?? null,
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.insert(entry);
    this.logger.info({ prNumber: params.prNumber, entryId: entry.id }, "PR enqueued");
    return entry;
  }

  dequeueEntry(entryId: string): boolean {
    const entry = this.store.getEntry(entryId);
    if (!entry) return false;
    this.store.dequeue(entryId);
    this.logger.info({ entryId, prNumber: entry.prNumber }, "Entry dequeued");
    return true;
  }

  updateEntryHead(entryId: string, headSha: string): boolean {
    const entry = this.store.getEntry(entryId);
    if (!entry) return false;
    this.store.updateHead(entryId, headSha);
    this.logger.info({ entryId, prNumber: entry.prNumber, headSha }, "Entry head updated");
    return true;
  }

  getStatus(): QueueEntry[] {
    return this.store.listAll(this.config.repoId);
  }

  getIncident(incidentId: string): IncidentRecord | undefined {
    return this.store.getIncident(incidentId);
  }

  listIncidents(entryId: string): IncidentRecord[] {
    return this.store.listIncidents(entryId);
  }

  /**
   * Try to admit a PR into the queue. Checks:
   * - Not already queued
   * - PR has admission label
   * - PR is approved
   * - Required checks are green
   * Called from webhook handler on label add or review approved.
   */
  async tryAdmit(prNumber: number, branch: string, headSha: string): Promise<boolean> {
    // Already queued?
    const existing = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (existing) {
      this.logger.debug({ prNumber }, "PR already queued, skipping admission");
      return false;
    }

    // Check approval, label, and CI via GitHub API.
    try {
      // Verify admission label is present.
      const labels = await this.github.listLabels(prNumber);
      if (!labels.includes(this.config.admissionLabel)) {
        this.logger.debug({ prNumber }, "PR missing admission label, skipping");
        return false;
      }

      const status = await this.github.getStatus(prNumber);
      if (!status.reviewApproved) {
        this.logger.debug({ prNumber }, "PR not approved, skipping admission");
        return false;
      }

      // Check if required checks pass. If no required checks configured,
      // we accept any approved PR with the label.
      if (this.config.requiredChecks.length > 0) {
        const checks = await this.github.listChecks(prNumber);
        const required = new Set(this.config.requiredChecks);
        const passing = checks.filter((c) => c.conclusion === "success" && required.has(c.name));
        if (passing.length < required.size) {
          this.logger.debug({ prNumber, passing: passing.length, required: required.size }, "Required checks not all green");
          return false;
        }
      }

      this.enqueue({ prNumber, branch, headSha });
      return true;
    } catch (err) {
      this.logger.warn({ prNumber, err }, "Failed to check admission eligibility");
      return false;
    }
  }

  /** Dequeue by PR number (webhook: PR closed or label removed). */
  dequeueByPR(prNumber: number): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.dequeue(entry.id);
      this.logger.info({ prNumber, entryId: entry.id }, "PR dequeued");
    }
  }

  /** Update head SHA by PR number (webhook: PR force-pushed). */
  updateHeadByPR(prNumber: number, headSha: string): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.updateHead(entry.id, headSha);
      this.logger.info({ prNumber, entryId: entry.id, headSha }, "PR head updated via webhook");
    }
  }

  /** Acknowledge an external merge (webhook: PR merged outside queue). */
  acknowledgeExternalMerge(prNumber: number): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.transition(entry.id, "merged");
      this.logger.info({ prNumber, entryId: entry.id }, "External merge acknowledged");
    }
  }

  private async runTick(): Promise<void> {
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      await reconcile({
        store: this.store,
        repoId: this.config.repoId,
        baseBranch: this.config.baseBranch,
        git: this.git,
        ci: this.ci,
        github: this.github,
        eviction: this.eviction,
        flakyRetries: this.config.flakyRetries,
        onMerged: (prNumber) => {
          this.logger.info({ prNumber }, "PR merged via queue");
        },
        onEvicted: (prNumber, context) => {
          this.logger.warn({ prNumber, failureClass: context.failureClass }, "PR evicted from queue");
        },
        onMainBroken: () => {
          this.logger.warn("Main branch CI is failing — queue paused");
        },
      });
    } catch (error) {
      this.logger.error({ error }, "Reconcile tick failed");
    } finally {
      this.tickInProgress = false;
      this.scheduleNextTick();
    }
  }

  private scheduleNextTick(): void {
    this.tickTimer = setTimeout(() => void this.runTick(), this.config.pollIntervalMs);
    this.tickTimer.unref?.();
  }
}
