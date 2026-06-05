import type { SerialWorkQueueRetryDecision } from "./service-queue.ts";

const SQLITE_LOCK_RETRY_DELAYS_MS = [250, 1_000, 2_500, 5_000, 10_000];

export function retrySqliteLockedQueueFailure(error: Error, attempt: number): SerialWorkQueueRetryDecision | undefined {
  if (!isSqliteDatabaseLockedError(error)) {
    return undefined;
  }
  const delayMs = SQLITE_LOCK_RETRY_DELAYS_MS[attempt - 1];
  return delayMs === undefined ? undefined : { delayMs };
}

export function isSqliteDatabaseLockedError(error: Error): boolean {
  return /\bdatabase is locked\b/i.test(error.message);
}
