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
