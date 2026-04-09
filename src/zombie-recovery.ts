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
