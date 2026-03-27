import type { QueueStore } from "./store.ts";
import type {
  QueueEntry,
  QueueEntryStatus,
  QueueEventRecord,
  RepairRequestRecord,
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
  private readonly repairRequests: RepairRequestRecord[] = [];
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
    patch?: Partial<Pick<QueueEntry, "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "repairAttempts">>,
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
      if (patch.repairAttempts !== undefined) entry.repairAttempts = patch.repairAttempts;
    }
    this.appendEvent(entryId, from, to);
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
    entry.repairAttempts = 0;
    entry.updatedAt = isoNow();
    // Abandon pending repair requests.
    for (const req of this.repairRequests) {
      if (req.entryId === entryId && req.outcome === "pending") {
        req.outcome = "abandoned";
      }
    }
    this.appendEvent(entryId, from, "queued", `updateHead: generation ${entry.generation}`);
  }

  insertRepairRequest(req: RepairRequestRecord): void {
    this.repairRequests.push({ ...req });
  }

  listRepairRequests(entryId: string): RepairRequestRecord[] {
    return this.repairRequests
      .filter((r) => r.entryId === entryId)
      .sort((a, b) => a.at.localeCompare(b.at));
  }

  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[] {
    const filtered = this.events.filter((e) => e.entryId === entryId);
    if (opts?.limit) return filtered.slice(-opts.limit);
    return filtered;
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
