import type {
  QueueEntry,
  QueueEntryStatus,
  QueueEventRecord,
  RepairRequestRecord,
} from "./types.ts";

/**
 * Persistence seam for queue state. Every mutation method appends a
 * queue_event row in the same transaction as the state change — callers
 * never need to write audit events separately.
 */
export interface QueueStore {
  // === Reads ===

  /** Get the current queue head: first non-terminal entry by position. */
  getHead(repoId: string): QueueEntry | undefined;

  /** Get a single entry by ID. */
  getEntry(entryId: string): QueueEntry | undefined;

  /** Get the active (non-terminal) entry for a PR in a repo. */
  getEntryByPR(repoId: string, prNumber: number): QueueEntry | undefined;

  /** All non-terminal entries for a repo, ordered by position. */
  listActive(repoId: string): QueueEntry[];

  /** All entries (including terminal) for a repo, ordered by position. */
  listAll(repoId: string): QueueEntry[];

  // === Mutations (each appends a queue_event in the same transaction) ===

  /** Insert a new entry. Appends an event (null → queued). */
  insert(entry: QueueEntry): void;

  /**
   * Transition an entry to a new status with optional field updates.
   * Appends an event (oldStatus → newStatus).
   */
  transition(
    entryId: string,
    to: QueueEntryStatus,
    patch?: Partial<Pick<QueueEntry,
      "headSha" | "baseSha" | "ciRunId" | "ciRetries" | "repairAttempts"
    >>,
  ): void;

  /**
   * Non-destructive removal: transitions to "dequeued" (terminal).
   * Preserves the entry for auditability.
   */
  dequeue(entryId: string): void;

  /**
   * Handle a PR force-push: reset to queued with a new headSha.
   * Clears all SHA-bound state: ciRunId, ciRetries, repairAttempts.
   * Increments generation. Abandons pending repair requests.
   */
  updateHead(entryId: string, newHeadSha: string): void;

  // === Repair tracking ===

  /** Record a repair request dispatch. */
  insertRepairRequest(req: RepairRequestRecord): void;

  /** List repair requests for an entry, ordered by at. */
  listRepairRequests(entryId: string): RepairRequestRecord[];

  // === Audit (read-only — writes are folded into mutations above) ===

  /** List events for an entry, ordered by id. */
  listEvents(entryId: string, opts?: { limit?: number }): QueueEventRecord[];
}
