import type { QueueStore } from "./store.ts";
import type {
  QueueEntry,
  QueueEntryStatus,
  QueueEventRecord,
  QueueEventSummary,
  IncidentRecord,
} from "./types.ts";
import { TERMINAL_STATUSES } from "./types.ts";

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * In-memory QueueStore for tests. Backed by Maps and arrays.
 * Event logging is folded into each mutation call.
 */
export class MemoryStore implements QueueStore {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly incidents: IncidentRecord[] = [];
  private readonly events: QueueEventRecord[] = [];
  private nextEventId = 1;

  getHead(repoId: string): QueueEntry | undefined {
    return this.listActive(repoId)[0];
  }

  getEntry(entryId: string): QueueEntry | undefined {
    const e = this.entries.get(entryId);
    return e ? { ...e } : undefined;
  }

  getEntryByPR(repoId: string, prNumber: number): QueueEntry | undefined {
    for (const e of this.entries.values()) {
      if (e.repoId === repoId && e.prNumber === prNumber && !TERMINAL_STATUSES.includes(e.status)) {
        return { ...e };
      }
    }
    return undefined;
  }

  listActive(repoId: string): QueueEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.repoId === repoId && !TERMINAL_STATUSES.includes(e.status))
      .sort((a, b) => a.position - b.position)
      .map((e) => ({ ...e }));
  }

  listAll(repoId: string): QueueEntry[] {
    return [...this.entries.values()]
      .filter((e) => e.repoId === repoId)
      .sort((a, b) => a.position - b.position)
      .map((e) => ({ ...e }));
  }

  insert(entry: QueueEntry): void {
    this.entries.set(entry.id, { ...entry });
    this.appendEvent(entry.id, null, entry.status);
  }

  transition(
    entryId: string,
    to: QueueEntryStatus,
    patch?: Partial<Pick<QueueEntry, "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "retryAttempts" | "lastFailedBaseSha" | "specBranch" | "specSha" | "specBasedOn">>,
    detail?: string,
  ): void {
    const entry = this.entries.get(entryId);
    if (!entry) return;
    const from = entry.status;
    entry.status = to;
    entry.updatedAt = isoNow();
    if (patch) {
      if (patch.headSha !== undefined) entry.headSha = patch.headSha;
      if (patch.baseSha !== undefined) entry.baseSha = patch.baseSha;
      if (patch.ciRunId !== undefined) entry.ciRunId = patch.ciRunId;
      if (patch.ciRetries !== undefined) entry.ciRetries = patch.ciRetries;
      if (patch.retryAttempts !== undefined) entry.retryAttempts = patch.retryAttempts;
      if (patch.lastFailedBaseSha !== undefined) entry.lastFailedBaseSha = patch.lastFailedBaseSha;
      if (patch.specBranch !== undefined) entry.specBranch = patch.specBranch;
      if (patch.specSha !== undefined) entry.specSha = patch.specSha;
      if (patch.specBasedOn !== undefined) entry.specBasedOn = patch.specBasedOn;
    }
    this.appendEvent(entryId, from, to, detail);
  }

  dequeue(entryId: string): void {
    this.transition(entryId, "dequeued");
  }

  updateHead(entryId: string, newHeadSha: string): void {
    const entry = this.entries.get(entryId);
    if (!entry || TERMINAL_STATUSES.includes(entry.status)) return;
    const from = entry.status;
    entry.headSha = newHeadSha;
    entry.status = "queued";
    entry.generation++;
    entry.ciRunId = null;
    entry.ciRetries = 0;
    entry.retryAttempts = 0;
    entry.lastFailedBaseSha = null;
    entry.specBranch = null;
    entry.specSha = null;
    entry.specBasedOn = null;
    entry.updatedAt = isoNow();
    this.appendEvent(entryId, from, "queued", `updateHead: generation ${entry.generation}`);
  }

  insertIncident(incident: IncidentRecord): void {
    this.incidents.push({ ...incident });
  }

  listIncidents(entryId: string): IncidentRecord[] {
    return this.incidents
      .filter((i) => i.entryId === entryId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  getIncident(incidentId: string): IncidentRecord | undefined {
    return this.incidents.find((i) => i.id === incidentId);
  }

  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[] {
    const filtered = this.events.filter((e) => e.entryId === entryId);
    if (opts?.limit) return filtered.slice(-opts.limit);
    return filtered;
  }

  listRecentEvents(repoId: string, opts?: { limit?: number }): QueueEventSummary[] {
    const filtered = this.events
      .map((event) => {
        const entry = this.entries.get(event.entryId);
        if (!entry || entry.repoId !== repoId) {
          return null;
        }
        return {
          ...event,
          prNumber: entry.prNumber,
          branch: entry.branch,
          issueKey: entry.issueKey,
        };
      })
      .filter((event): event is QueueEventSummary => event !== null);
    const limited = opts?.limit ? filtered.slice(-opts.limit) : filtered;
    return limited;
  }

  private appendEvent(
    entryId: string,
    fromStatus: QueueEntryStatus | null,
    toStatus: QueueEntryStatus,
    detail?: string,
  ): void {
    this.events.push({
      id: this.nextEventId++,
      entryId,
      at: isoNow(),
      fromStatus,
      toStatus,
      detail,
    });
  }
}
