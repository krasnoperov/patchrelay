import type { QueueStore } from "./store.ts";
import type { QueueEntry, QueueEntryDetail, QueueRuntimeStatus, QueueWatchSnapshot } from "./types.ts";
import type { StewardConfig } from "./config.ts";
import { buildQueueSummary } from "./watch/dashboard-model.ts";
import type { MergeStewardRuntime } from "./service-runtime.ts";

export class MergeStewardWatchQueries {
  constructor(
    private readonly config: StewardConfig,
    private readonly store: QueueStore,
    private readonly runtime: MergeStewardRuntime,
  ) {}

  getStatus(): QueueEntry[] {
    return this.store.listAll(this.config.repoId);
  }

  getIncident(incidentId: string) {
    return this.store.getIncident(incidentId);
  }

  listIncidents(entryId: string) {
    return this.store.listIncidents(entryId);
  }

  getRuntimeStatus(): QueueRuntimeStatus {
    return this.runtime.getRuntimeStatus();
  }

  getWatchSnapshot(options?: { eventLimit?: number }): QueueWatchSnapshot {
    const entries = this.store.listAll(this.config.repoId);
    return {
      repoId: this.config.repoId,
      repoFullName: this.config.repoFullName,
      baseBranch: this.config.baseBranch,
      githubPolicy: this.runtime.getGitHubPolicy(),
      summary: buildQueueSummary(entries),
      runtime: this.runtime.getRuntimeStatus(),
      queueBlock: this.runtime.getCurrentQueueBlock(),
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
}
