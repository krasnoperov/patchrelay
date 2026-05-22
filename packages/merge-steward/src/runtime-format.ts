import type { QueueRuntimeStatus, ReconcileEventSummary } from "./types.ts";

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "unknown duration";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder === 0 ? `${minutes}m` : `${minutes}m${remainder}s`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder === 0 ? `${hours}h` : `${hours}h${minuteRemainder}m`;
}

export function formatReconcileEvent(event: ReconcileEventSummary | null | undefined): string | null {
  if (!event) return null;
  return `${event.action} PR #${event.prNumber}${event.detail ? ` (${event.detail})` : ""} at ${event.at}`;
}

export function formatRuntimeActivity(runtime: QueueRuntimeStatus): string[] {
  if (!runtime.tickInProgress) return [];
  const age = formatDurationMs(runtime.tickAgeMs);
  const started = runtime.lastTickStartedAt ? `, started ${runtime.lastTickStartedAt}` : "";
  const lines = [
    `Reconcile: ${runtime.staleTick ? "stale" : "running"} for ${age}${started}`,
  ];
  const latest = formatReconcileEvent(runtime.lastReconcileEvent);
  if (latest) lines.push(`Latest action: ${latest}`);
  if (runtime.staleTick) {
    lines.push(`Warning: reconcile tick appears stale; threshold ${formatDurationMs(runtime.staleTickThresholdMs)}.`);
  }
  return lines;
}
