import type { Logger } from "pino";
import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter } from "./interfaces.ts";
import type { QueueStore } from "./store.ts";
import type {
  CheckResult,
  QueueBlockState,
  QueueEntry,
  IncidentRecord,
  QueueEntryDetail,
  QueueRuntimeStatus,
  QueueStatusSummary,
  QueueWatchSnapshot,
  ReconcileEvent,
} from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";
import type { StewardConfig } from "./config.ts";
import { reconcile } from "./reconciler.ts";
import { INVALIDATION_PATCH, selectDownstream } from "./invalidation.ts";
import { randomUUID } from "node:crypto";

/**
 * Merge steward service. Runs a timer-driven reconciliation loop and
 * exposes methods for the HTTP API to call.
 */
export class MergeStewardService {
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private tickInProgress = false;
  private nextPosition = 1;
  private lastTickStartedAt: string | null = null;
  private lastTickCompletedAt: string | null = null;
  private lastTickOutcome: QueueRuntimeStatus["lastTickOutcome"] = "idle";
  private lastTickError: string | null = null;
  private currentQueueBlock: QueueBlockState | null = null;

  constructor(
    private readonly config: StewardConfig,
    private readonly store: QueueStore,
    private readonly git: GitOperations,
    private readonly ci: CIRunner,
    private readonly github: GitHubPRApi,
    private readonly eviction: EvictionReporter,
    private readonly specBuilder: import("./interfaces.ts").SpeculativeBranchBuilder,
    private readonly logger: Logger,
  ) {
    const existing = store.listAll(config.repoId);
    for (const e of existing) {
      if (e.position >= this.nextPosition) {
        this.nextPosition = e.position + 1;
      }
    }
  }

  /** Expose the GitHub client for webhook handler branch→PR lookups. */
  get githubApi(): GitHubPRApi {
    return this.github;
  }

  async start(): Promise<void> {
    this.logger.info({ pollIntervalMs: this.config.pollIntervalMs }, "Steward service starting");
    this.scheduleNextTick();

    // Best-effort: scan GitHub for open PRs that may already satisfy the
    // merge gate and aren't already in the queue (recovers state after restart).
    try {
      const open = await this.github.listOpenPRs();
      let admitted = 0;
      for (const pr of open) {
        if (await this.tryAdmit(pr.number, pr.branch, pr.headSha)) admitted++;
      }
      if (open.length > 0) {
        this.logger.info({ scanned: open.length, admitted }, "Startup scan for eligible open PRs complete");
      }
    } catch (err) {
      this.logger.warn({ err }, "Startup scan for eligible open PRs failed");
    }
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
    priority?: number;
  }): QueueEntry | undefined {
    // Pre-check: if an active entry already exists for this PR, don't
    // attempt the insert. This is also enforced by the UNIQUE partial
    // index (idx_one_active_per_pr), but handling it here gives a clear
    // log message instead of a raw constraint error.
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
      position: this.nextPosition++,
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
      enqueuedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      this.store.insert(entry);
    } catch (err) {
      // UNIQUE constraint race: another entry was inserted between our
      // pre-check and the insert. Return the existing entry.
      const raced = this.store.getEntryByPR(this.config.repoId, params.prNumber);
      if (raced) {
        this.logger.warn(
          { prNumber: params.prNumber, existingEntryId: raced.id },
          "Duplicate enqueue caught by constraint: returning existing entry",
        );
        return raced;
      }
      throw err; // Not a duplicate constraint — re-throw the real error.
    }

    this.logger.info({ prNumber: params.prNumber, entryId: entry.id }, "PR enqueued");
    return entry;
  }

  dequeueEntry(entryId: string): boolean {
    const entry = this.store.getEntry(entryId);
    if (!entry) return false;
    this.store.dequeue(entryId);
    this.invalidateDownstreamOf(entry);
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

  getRuntimeStatus(): QueueRuntimeStatus {
    return {
      tickInProgress: this.tickInProgress,
      lastTickStartedAt: this.lastTickStartedAt,
      lastTickCompletedAt: this.lastTickCompletedAt,
      lastTickOutcome: this.lastTickOutcome,
      lastTickError: this.lastTickError,
    };
  }

  getWatchSnapshot(options?: { eventLimit?: number }): QueueWatchSnapshot {
    const entries = this.store.listAll(this.config.repoId);
    return {
      repoId: this.config.repoId,
      repoFullName: this.config.repoFullName,
      baseBranch: this.config.baseBranch,
      summary: buildSummary(entries),
      runtime: this.getRuntimeStatus(),
      queueBlock: this.currentQueueBlock,
      entries,
      recentEvents: this.store.listRecentEvents(this.config.repoId, { limit: options?.eventLimit ?? 40 }),
    };
  }

  getEntryDetail(entryId: string, options?: { eventLimit?: number }): QueueEntryDetail | undefined {
    const entry = this.store.getEntry(entryId);
    if (!entry || entry.repoId !== this.config.repoId) {
      return undefined;
    }
    return {
      entry,
      events: this.store.listEvents(entryId, { limit: options?.eventLimit ?? 200 }),
      incidents: this.store.listIncidents(entryId),
    };
  }

  async triggerReconcile(): Promise<{ started: boolean; runtime: QueueRuntimeStatus }> {
    const started = await this.runTick();
    return {
      started,
      runtime: this.getRuntimeStatus(),
    };
  }

  /**
   * Try to admit a PR into the queue. Checks:
   * - Not already queued
   * - PR is approved
   * - Required checks are green
   * Called from webhook handler on label add, review approved, or green CI.
   */
  async tryAdmit(prNumber: number, branch: string, headSha: string): Promise<boolean> {
    // Excluded branch?
    if (this.config.excludeBranches.some((pattern) => matchGlob(pattern, branch))) {
      this.logger.debug({ prNumber, branch }, "Branch excluded from admission");
      return false;
    }

    // Already queued?
    const existing = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (existing) {
      this.logger.debug({ prNumber }, "PR already queued, skipping admission");
      return false;
    }

    // Check approval, label, and CI via GitHub API.
    try {
      const status = await this.github.getStatus(prNumber);
      if (!status.reviewApproved) {
        this.logger.debug({ prNumber }, "PR not approved, skipping admission");
        return false;
      }

      // Check CI status. If requiredChecks is configured, all must pass.
      // If empty, at least one non-steward check must be green.
      const checks = await this.github.listChecks(prNumber);
      if (this.config.requiredChecks.length > 0) {
        const required = new Set(this.config.requiredChecks);
        const passing = checks.filter((c) => c.conclusion === "success" && required.has(c.name));
        if (passing.length < required.size) {
          this.logger.debug({ prNumber, passing: passing.length, required: required.size }, "Required checks not all green");
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
      this.invalidateDownstreamOf(entry);
      this.logger.info({ prNumber, entryId: entry.id }, "PR dequeued");
    }
  }

  /** Update head SHA by PR number (webhook: PR force-pushed). */
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

  /** Acknowledge an external merge (webhook: PR merged outside queue). */
  acknowledgeExternalMerge(prNumber: number): void {
    const entry = this.store.getEntryByPR(this.config.repoId, prNumber);
    if (entry) {
      this.store.transition(entry.id, "merged");
      this.invalidateDownstreamOf(entry);
      this.logger.info({ prNumber, entryId: entry.id }, "External merge acknowledged");
    }
  }

  /**
   * Reset all active entries positioned after the given entry to preparing_head
   * with clean spec/CI state. Prevents downstream specs that included the
   * dequeued entry's changes from being merged to main.
   */
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

  private async runTick(): Promise<boolean> {
    if (this.tickInProgress) return false;
    this.tickInProgress = true;
    this.lastTickStartedAt = new Date().toISOString();
    this.lastTickOutcome = "running";
    this.lastTickError = null;
    try {
      let tickQueueBlockEvent: ReconcileEvent | null = null;
      await reconcile({
        store: this.store,
        repoId: this.config.repoId,
        baseBranch: this.config.baseBranch,
        remotePrefix: "origin/",
        git: this.git,
        ci: this.ci,
        github: this.github,
        specBuilder: this.specBuilder,
        speculativeDepth: this.config.speculativeDepth,
        eviction: this.eviction,
        flakyRetries: this.config.flakyRetries,
        onEvent: (event) => {
          const isWarn = event.action === "evicted" || event.action === "spec_build_conflict"
            || event.action === "ci_failed"
            || event.action === "merge_rejected" || event.action === "budget_exhausted";
          const isDebug = event.action === "ci_pending" || event.action === "retry_gated"
            || event.action === "fetch_started";
          const level = isWarn ? "warn" : isDebug ? "debug" : "info";
          this.logger[level]({ ...event }, `Queue: ${event.action} PR #${event.prNumber}`);

          if (event.action === "main_broken" && tickQueueBlockEvent === null) {
            tickQueueBlockEvent = event;
          }
        },
      });
      this.currentQueueBlock = tickQueueBlockEvent ? await this.describeMainBroken(tickQueueBlockEvent) : null;
      this.lastTickOutcome = "succeeded";
    } catch (error) {
      this.lastTickOutcome = "failed";
      this.currentQueueBlock = null;
      // Preserve stack + message for the watch API. The reconciler wraps
      // per-entry errors with [PR #N entryId phase=X] context.
      this.lastTickError = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
      this.logger.error(
        { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
        "Reconcile tick failed",
      );
    } finally {
      this.tickInProgress = false;
      this.lastTickCompletedAt = new Date().toISOString();
      this.scheduleNextTick();
    }
    return true;
  }

  private scheduleNextTick(): void {
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
    }
    this.tickTimer = setTimeout(() => void this.runTick(), this.config.pollIntervalMs);
    this.tickTimer.unref?.();
  }

  private async describeMainBroken(event: ReconcileEvent): Promise<QueueBlockState> {
    const baseRef = `origin/${this.config.baseBranch}`;
    let baseSha: string | null = null;
    try {
      baseSha = await this.git.headSha(baseRef);
    } catch {
      try {
        baseSha = await this.git.headSha(this.config.baseBranch);
      } catch {
        baseSha = event.baseSha ?? null;
      }
    }

    const checkRef = event.baseSha ?? baseSha ?? baseRef;
    let checks: CheckResult[] = [];
    try {
      checks = await this.github.listChecksForRef(checkRef);
    } catch {
      checks = [];
    }

    return {
      reason: "main_broken",
      entryId: event.entryId,
      headPrNumber: event.prNumber,
      baseBranch: this.config.baseBranch,
      baseSha,
      observedAt: event.at,
      failingChecks: event.failingChecks ?? checks.filter((check) => check.conclusion === "failure"),
      pendingChecks: event.pendingChecks ?? checks.filter((check) => check.conclusion === "pending"),
    };
  }
}

/** Simple glob match: supports * as wildcard. */
function matchGlob(pattern: string, value: string): boolean {
  const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
  return regex.test(value);
}

export function buildSummary(entries: QueueEntry[]): QueueStatusSummary {
  const summary: QueueStatusSummary = {
    total: entries.length,
    active: 0,
    queued: 0,
    preparingHead: 0,
    validating: 0,
    merging: 0,
    merged: 0,
    evicted: 0,
    dequeued: 0,
    headEntryId: null,
    headPrNumber: null,
  };

  const activeEntries = entries.filter((entry) => !TERMINAL_STATUSES.includes(entry.status));
  if (activeEntries.length > 0) {
    summary.headEntryId = activeEntries[0]!.id;
    summary.headPrNumber = activeEntries[0]!.prNumber;
    summary.active = activeEntries.length;
  }

  for (const entry of entries) {
    switch (entry.status) {
      case "queued":
        summary.queued += 1;
        break;
      case "preparing_head":
        summary.preparingHead += 1;
        break;
      case "validating":
        summary.validating += 1;
        break;
      case "merging":
        summary.merging += 1;
        break;
      case "merged":
        summary.merged += 1;
        break;
      case "evicted":
        summary.evicted += 1;
        break;
      case "dequeued":
        summary.dequeued += 1;
        break;
    }
  }

  return summary;
}
