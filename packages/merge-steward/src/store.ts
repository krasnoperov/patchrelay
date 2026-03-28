import type {
  QueueEntry,
  QueueEntryStatus,
  QueueEventRecord,
  QueueEventSummary,
  IncidentRecord,
} from "./types.ts";

/**
 * Persistence seam for queue state. Every mutation method appends a
 * queue_event row in the same transaction as the state change — callers
 * never need to write audit events separately.
 */
export interface QueueStore {
  // === Reads ===
  getHead(repoId: string): QueueEntry | undefined;
  getEntry(entryId: string): QueueEntry | undefined;
  getEntryByPR(repoId: string, prNumber: number): QueueEntry | undefined;
  listActive(repoId: string): QueueEntry[];
  listAll(repoId: string): QueueEntry[];

  // === Mutations (each appends a queue_event in the same transaction) ===
  insert(entry: QueueEntry): void;
  transition(
    entryId: string,
    to: QueueEntryStatus,
    patch?: Partial<Pick<QueueEntry,
      "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "retryAttempts" | "lastFailedBaseSha" | "specBranch" | "specSha" | "specBasedOn"
    >>,
  ): void;
  dequeue(entryId: string): void;
  updateHead(entryId: string, newHeadSha: string): void;

  // === Incidents (durable eviction records) ===
  insertIncident(incident: IncidentRecord): void;
  listIncidents(entryId: string): IncidentRecord[];
  getIncident(incidentId: string): IncidentRecord | undefined;

  // === Audit (read-only — writes folded into mutations above) ===
  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[];
  listRecentEvents(repoId: string, opts?: { limit?: number }): QueueEventSummary[];
}
