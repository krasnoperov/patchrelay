import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord, RunStatus } from "./db-types.ts";
import type { UpsertIssueParams } from "./db/issue-store.ts";
import type { IssueSessionLease } from "./issue-session-lease-service.ts";

const WRITER = "run-settlement";

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "released", "superseded"]);

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export interface SettleRunParams {
  db: PatchRelayDatabase;
  run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">;
  /**
   * Terminal outcome recorded when the run row is not yet terminal. Recovery
   * callers settling a run that is already terminal omit it; a non-terminal
   * run with no outcome is left untouched (it legitimately holds the slot).
   */
  finish?: {
    status: RunStatus;
    threadId?: string;
    turnId?: string;
    failureReason?: string;
    summaryJson?: string;
    reportJson?: string;
  } | undefined;
  lease?: IssueSessionLease | undefined;
  /**
   * Extra fields merged into the slot-clearing issue write (e.g. the
   * finalizer's post-run factoryState). Always computed from the fresh row
   * read inside the transaction, never from a stale caller-side read.
   */
  buildIssueUpdate?: ((current: IssueRecord) => Omit<UpsertIssueParams, "projectId" | "linearIssueId" | "activeRunId">) | undefined;
}

export interface SettleRunResult {
  /** This call moved the run row to a terminal status. */
  runFinished: boolean;
  /** This call cleared `issue.activeRunId`. */
  slotCleared: boolean;
  /** Issue row after the commit (or the unmodified row when nothing was written). */
  issue: IssueRecord | undefined;
}

// Phase B1 (core simplification plan): the fast, transactional, idempotent
// half of run finalization. One transaction marks the run terminal and
// clears the issue's active slot — the two writes whose separation caused
// the dangling-active-run freeze (PR #566): a restart landing between them
// left `activeRunId` pointing at a terminal run forever, hiding the issue
// from every idle/recovery pass. Safe to call from both the notification
// finalizer and reconciliation at any time:
//   - already-terminal run → finishRun skipped;
//   - slot already cleared or re-pointed at another run → issue untouched;
//   - non-terminal run with no `finish` outcome → full no-op.
export function settleRun(params: SettleRunParams): SettleRunResult {
  const { db, run } = params;
  return db.transaction((): SettleRunResult => {
    const freshRun = db.runs.getRunById(run.id);
    if (!freshRun) {
      return { runFinished: false, slotCleared: false, issue: db.issues.getIssue(run.projectId, run.linearIssueId) };
    }
    let runFinished = false;
    if (!isTerminalRunStatus(freshRun.status)) {
      if (!params.finish) {
        return { runFinished: false, slotCleared: false, issue: db.issues.getIssue(run.projectId, run.linearIssueId) };
      }
      db.runs.finishRun(run.id, params.finish);
      runFinished = true;
    }
    const current = db.issues.getIssue(run.projectId, run.linearIssueId);
    if (!current || current.activeRunId !== run.id) {
      return { runFinished, slotCleared: false, issue: current };
    }
    const buildUpdate = (record: IssueRecord): UpsertIssueParams => ({
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      ...params.buildIssueUpdate?.(record),
      // After the caller-provided fields so nothing can override the clear.
      activeRunId: null,
    });
    const commit = db.issueSessions.commitIssueState({
      writer: WRITER,
      ...(params.lease ? { lease: params.lease } : {}),
      expectedVersion: current.version,
      update: buildUpdate(current),
      // The read above happened inside this same transaction, so a version
      // conflict cannot normally occur; the predicate keeps the invariant
      // explicit: never clear a slot that was re-pointed at another run.
      onConflict: (fresh) => (fresh.activeRunId === run.id ? buildUpdate(fresh) : undefined),
    });
    if (commit.outcome !== "applied") {
      return { runFinished, slotCleared: false, issue: commit.outcome === "conflict_skipped" ? commit.issue : current };
    }
    return { runFinished, slotCleared: true, issue: commit.issue };
  });
}
