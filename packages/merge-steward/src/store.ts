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
      "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "retryAttempts" | "lastFailedBaseSha" | "specBranch" | "specSha" | "specBasedOn" | "waitDetail"
      | "postMergeStatus" | "postMergeSha" | "postMergeSummary" | "postMergeCheckedAt"
      | "headPatchId" | "specTreeId"
    >>,
    detail?: string,
  ): void;
  dequeue(entryId: string): void;
  updateHead(entryId: string, newHeadSha: string): void;
  /**
   * Plan §5.3: patch-id-aware short-circuit. The new head is
   * patch-id-equivalent to the cached identity AND the freshly
   * computed merge tree matches the cached spec tree. We rebuild the
   * spec commit with the new head as its second parent (so GitHub
   * marks the PR merged after fast-forward) but do not blow away the
   * spec branch or restart the prepare cycle. CI must re-run on the
   * new spec SHA — check_runs are SHA-anchored and there is no API
   * to reuse a passing verdict.
   */
  rebuildSpecHeadEquivalent(
    entryId: string,
    patch: {
      headSha: string;
      specSha: string;
      specBranch: string;
      headPatchId: string;
      specTreeId: string;
      ciRunId: string | null;
    },
    detail?: string,
  ): void;
  updatePriority(entryId: string, priority: number, detail?: string): void;

  // === Incidents (durable eviction records) ===
  insertIncident(incident: IncidentRecord): void;
  listIncidents(entryId: string): IncidentRecord[];
  getIncident(incidentId: string): IncidentRecord | undefined;

  // === Audit (read-only — writes folded into mutations above) ===
  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[];
  listRecentEvents(repoId: string, opts?: { limit?: number }): QueueEventSummary[];
}
