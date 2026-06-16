import type { ProjectConfig } from "./workflow-types.ts";

// Plan §B4: the single budget table. Every retry/attempt budget in the
// system lives here — the per-runType repair budgets consulted by the
// wake planner before a launch, and the zombie-recovery budget consulted
// by the RunFailurePolicy when a run dies without doing its work.
export interface RunBudgetTable {
  ciRepair: number;
  queueRepair: number;
  reviewFix: number;
  /** Retries for runs that died without doing work (zombie / stale thread). */
  zombieRecovery: number;
}

export const DEFAULT_RUN_BUDGETS: RunBudgetTable = {
  ciRepair: 10,
  queueRepair: 10,
  reviewFix: 10,
  zombieRecovery: 5,
};

export function resolveRunBudgets(project: ProjectConfig | undefined): RunBudgetTable {
  return {
    ciRepair: project?.repairBudgets?.ciRepair ?? DEFAULT_RUN_BUDGETS.ciRepair,
    queueRepair: project?.repairBudgets?.queueRepair ?? DEFAULT_RUN_BUDGETS.queueRepair,
    reviewFix: project?.repairBudgets?.reviewFix ?? DEFAULT_RUN_BUDGETS.reviewFix,
    // No per-project override exists for zombie recovery yet; add one to
    // ProjectConfig.repairBudgets if a project ever needs it.
    zombieRecovery: DEFAULT_RUN_BUDGETS.zombieRecovery,
  };
}

export function getCiRepairBudget(project: ProjectConfig | undefined): number {
  return resolveRunBudgets(project).ciRepair;
}

export function getQueueRepairBudget(project: ProjectConfig | undefined): number {
  return resolveRunBudgets(project).queueRepair;
}

export function getReviewFixBudget(project: ProjectConfig | undefined): number {
  return resolveRunBudgets(project).reviewFix;
}

export function getZombieRecoveryBudget(project: ProjectConfig | undefined): number {
  return resolveRunBudgets(project).zombieRecovery;
}

// ─── Zombie-recovery backoff schedule (formerly zombie-recovery.ts) ──
//
// Exponential backoff between retries of a run that died without doing
// its work. Owned here with the budgets so the whole retry discipline
// (how many attempts, how far apart) reads in one place.

const ZOMBIE_RECOVERY_BASE_DELAY_MS = 15_000;

export function getZombieRecoveryDelayMs(recoveryAttempts: number): number {
  return ZOMBIE_RECOVERY_BASE_DELAY_MS * Math.pow(2, recoveryAttempts);
}

export function getRemainingZombieRecoveryDelayMs(
  lastRecoveryAt: string | undefined,
  recoveryAttempts: number,
  now = Date.now(),
): number {
  if (!lastRecoveryAt) return 0;
  const recoveredAtMs = Date.parse(lastRecoveryAt);
  if (!Number.isFinite(recoveredAtMs)) return 0;
  const delay = getZombieRecoveryDelayMs(recoveryAttempts);
  return Math.max(0, recoveredAtMs + delay - now);
}

// ─── Codex capacity backoff ──────────────────────────────────────────
//
// A run that failed on a Codex capacity outage (usage limit / rate limit /
// quota / model-at-capacity) is re-enqueued, not escalated, and never consumes
// a repair budget. The retry waits until the provider-announced retry time when
// one was parsed from the error (plus a small jitter so a fleet of issues does
// not stampede the moment the limit resets); otherwise it uses an escalating
// backoff keyed on how many times this issue has consecutively hit capacity —
// short at first (transient model overload usually clears fast) and longer if
// it persists.

// Escalating backoff steps for consecutive capacity failures with no
// provider-announced retry time: 2 min, then 5 min, then 10 min (capped).
export const CAPACITY_BACKOFF_STEPS_MS: readonly number[] = [2 * 60_000, 5 * 60_000, 10 * 60_000];

// Retained for callers/tests that reference the longest step.
export const CAPACITY_RETRY_BACKOFF_MS = CAPACITY_BACKOFF_STEPS_MS[CAPACITY_BACKOFF_STEPS_MS.length - 1]!;

const CAPACITY_RETRY_JITTER_MS = 60_000;

export function capacityBackoffStepMs(attempts: number): number {
  const index = Math.min(Math.max(Math.trunc(attempts), 1), CAPACITY_BACKOFF_STEPS_MS.length) - 1;
  return CAPACITY_BACKOFF_STEPS_MS[index]!;
}

export function resolveCapacityBackoffUntil(
  retryAtIso: string | undefined,
  attempts = CAPACITY_BACKOFF_STEPS_MS.length,
  now = Date.now(),
  jitterMs = Math.floor(Math.random() * CAPACITY_RETRY_JITTER_MS),
): string {
  const retryAtMs = retryAtIso !== undefined ? Date.parse(retryAtIso) : Number.NaN;
  const untilMs = Number.isFinite(retryAtMs) && retryAtMs > now
    ? retryAtMs + jitterMs
    : now + capacityBackoffStepMs(attempts) + jitterMs;
  return new Date(untilMs).toISOString();
}

export function getRemainingCapacityBackoffMs(
  capacityBackoffUntil: string | undefined,
  now = Date.now(),
): number {
  if (!capacityBackoffUntil) return 0;
  const untilMs = Date.parse(capacityBackoffUntil);
  if (!Number.isFinite(untilMs)) return 0;
  return Math.max(0, untilMs - now);
}
