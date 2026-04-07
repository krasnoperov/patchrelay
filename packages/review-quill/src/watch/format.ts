import type { ReviewAttemptRecord, ReviewQuillRuntimeStatus, WebhookEventRecord } from "../types.ts";

export function truncate(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) return value;
  if (maxWidth <= 1) return value.slice(0, maxWidth);
  return `${value.slice(0, Math.max(0, maxWidth - 1))}\u2026`;
}

export function formatSha(value: string): string {
  return value.slice(0, 10);
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return "never";
  const deltaMs = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(deltaMs)) return "unknown";
  const deltaSeconds = Math.max(0, Math.floor(deltaMs / 1_000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 48) return `${deltaHours}h`;
  return `${Math.floor(deltaHours / 24)}d`;
}

export function runtimeLabel(runtime: ReviewQuillRuntimeStatus): string {
  if (runtime.reconcileInProgress || runtime.lastReconcileOutcome === "running") return "running";
  if (runtime.lastReconcileOutcome === "failed") return "failed";
  if (runtime.lastReconcileOutcome === "succeeded") return "ok";
  return "idle";
}

export function attemptStateColor(attempt: ReviewAttemptRecord): string {
  if (attempt.status === "running") return "yellow";
  if (attempt.status === "queued") return "cyan";
  if (attempt.status === "failed") return "red";
  if (attempt.status === "superseded" || attempt.status === "cancelled") return "gray";
  if (attempt.conclusion === "approved") return "green";
  if (attempt.conclusion === "declined") return "red";
  return "white";
}

export function attemptLabel(attempt: ReviewAttemptRecord): string {
  if (attempt.status === "completed" && attempt.conclusion === "approved") return "approved";
  if (attempt.status === "completed" && attempt.conclusion === "declined") return "changes";
  if (attempt.status === "completed" && attempt.conclusion === "error") return "error";
  if (attempt.status === "superseded") return "superseded";
  if (attempt.status === "cancelled") return "cancelled";
  return attempt.status;
}

export function webhookLabel(event: WebhookEventRecord): string {
  const repo = event.repoFullName ?? "unknown repo";
  const processed = event.processedAt ? "processed" : event.ignoredReason ? `ignored:${event.ignoredReason}` : "pending";
  return `${repo} ${event.eventType} ${processed}`;
}
