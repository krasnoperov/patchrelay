import type { Logger } from "pino";
import type { GitOperations, CIRunner, GitHubPRApi, EvictionReporter, SpeculativeBranchBuilder } from "./interfaces.ts";
import type { QueueEntry, QueueEntryDetail, IncidentRecord, QueueRuntimeStatus, QueueWatchSnapshot } from "./types.ts";
import type { StewardConfig } from "./config.ts";
import type { GitHubPolicyCache, GitHubPolicyRefreshResult, GitHubPolicySnapshot } from "./github-policy.ts";
import type { QueueStore } from "./store.ts";
import { MergeStewardRuntime } from "./service-runtime.ts";
import { MergeStewardQueueCommands } from "./service-queue.ts";
import { MergeStewardWatchQueries } from "./service-watch.ts";

/**
 * Merge steward service. The public shell stays thin and delegates
 * lifecycle, queue mutations, and query shaping to focused helpers.
 */
export class MergeStewardService {
  private readonly runtime: MergeStewardRuntime;
  private readonly queueCommands: MergeStewardQueueCommands;
  private readonly watchQueries: MergeStewardWatchQueries;

  constructor(
    private readonly config: StewardConfig,
    private readonly policy: GitHubPolicyCache,
    private readonly store: QueueStore,
    private readonly git: GitOperations,
    private readonly ci: CIRunner,
    private readonly github: GitHubPRApi,
    private readonly eviction: EvictionReporter,
    private readonly specBuilder: SpeculativeBranchBuilder,
    private readonly logger: Logger,
  ) {
    this.queueCommands = new MergeStewardQueueCommands(config, policy, store, github, specBuilder, logger);
    this.runtime = new MergeStewardRuntime(
      config,
      policy,
      store,
      git,
      ci,
      github,
      eviction,
      specBuilder,
      logger,
      async () => {
        await this.queueCommands.scanEligibleOpenPrs();
      },
    );
    this.watchQueries = new MergeStewardWatchQueries(config, store, this.runtime);
  }

  /** Expose the GitHub client for webhook handler branch→PR lookups. */
  get githubApi(): GitHubPRApi {
    return this.github;
  }

  async start(): Promise<void> {
    await this.runtime.start();
    await this.queueCommands.scanStartupAdmissions();
  }

  async stop(): Promise<void> {
    await this.runtime.stop();
  }

  enqueue(params: {
    prNumber: number;
    branch: string;
    headSha: string;
    issueKey?: string;
    priority?: number;
  }): QueueEntry | undefined {
    return this.queueCommands.enqueue(params);
  }

  async tryAdmit(prNumber: number, branch: string, headSha: string): Promise<boolean> {
    return await this.queueCommands.tryAdmit(prNumber, branch, headSha);
  }

  dequeueEntry(entryId: string): boolean {
    const entry = this.store.getEntry(entryId);
    if (!entry) {
      return false;
    }
    this.queueCommands.dequeueByPR(entry.prNumber);
    return true;
  }

  updateEntryHead(entryId: string, headSha: string): boolean {
    const entry = this.store.getEntry(entryId);
    if (!entry) {
      return false;
    }
    this.queueCommands.updateHeadByPR(entry.prNumber, headSha);
    return true;
  }

  dequeueByPR(prNumber: number): void {
    this.queueCommands.dequeueByPR(prNumber);
  }

  updateHeadByPR(prNumber: number, headSha: string): void {
    this.queueCommands.updateHeadByPR(prNumber, headSha);
  }

  updatePriorityByPR(prNumber: number, priority: number): boolean {
    return this.queueCommands.updatePriorityByPR(prNumber, priority);
  }

  acknowledgeExternalMerge(prNumber: number): void {
    this.queueCommands.acknowledgeExternalMerge(prNumber);
  }

  getStatus(): QueueEntry[] {
    return this.watchQueries.getStatus();
  }

  getIncident(incidentId: string): IncidentRecord | undefined {
    return this.watchQueries.getIncident(incidentId);
  }

  listIncidents(entryId: string): IncidentRecord[] {
    return this.watchQueries.listIncidents(entryId);
  }

  getRuntimeStatus(): QueueRuntimeStatus {
    return this.runtime.getRuntimeStatus();
  }

  getWatchSnapshot(options?: { eventLimit?: number }): QueueWatchSnapshot {
    return this.watchQueries.getWatchSnapshot(options);
  }

  getEntryDetail(entryId: string, options?: { eventLimit?: number }): QueueEntryDetail | undefined {
    return this.watchQueries.getEntryDetail(entryId, options);
  }

  async triggerReconcile(): Promise<{ started: boolean; runtime: ReturnType<MergeStewardRuntime["getRuntimeStatus"]> }> {
    return await this.runtime.triggerReconcile();
  }

  getGitHubPolicy(): GitHubPolicySnapshot {
    return this.policy.getSnapshot();
  }

  async refreshGitHubPolicyFromWebhook(reason: string): Promise<GitHubPolicyRefreshResult> {
    return await this.policy.refreshFromWebhook(reason);
  }
}
