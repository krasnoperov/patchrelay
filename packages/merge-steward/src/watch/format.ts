import type { CheckResult, QueueBlockState, QueueEntryStatus, QueueEventRecord, QueueEventSummary, QueueRuntimeStatus } from "../types.ts";

export function shortSha(value: string | null | undefined): string {
  if (!value) {
    return "-";
  }
  return value.slice(0, 7);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) {
    return "-";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return "now";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function statusColor(status: QueueEntryStatus): "yellow" | "cyan" | "green" | "red" | "gray" {
  switch (status) {
    case "queued":
      return "yellow";
    case "preparing_head":
    case "validating":
    case "merging":
      return "cyan";
    case "merged":
      return "green";
    case "evicted":
      return "red";
    case "dequeued":
      return "gray";
  }
}

export function humanStatus(status: QueueEntryStatus): string {
  switch (status) {
    case "queued":
      return "queued";
    case "preparing_head":
      return "refreshing branch";
    case "validating":
      return "running CI";
    case "merging":
      return "merging to main";
    case "merged":
      return "merged";
    case "evicted":
      return "removed from queue";
    case "dequeued":
      return "dequeued";
  }
}

export function queueProgress(status: QueueEntryStatus): { current: number; total: number } {
  switch (status) {
    case "queued":
      return { current: 1, total: 4 };
    case "preparing_head":
      return { current: 2, total: 4 };
    case "validating":
      return { current: 3, total: 4 };
    case "merging":
    case "merged":
    case "evicted":
    case "dequeued":
      return { current: 4, total: 4 };
  }
}

export function nextStepLabel(status: QueueEntryStatus): string {
  switch (status) {
    case "queued":
      return "waiting for head-of-line turn";
    case "preparing_head":
      return "rebasing onto latest main";
    case "validating":
      return "waiting for CI result";
    case "merging":
      return "final GitHub merge";
    case "merged":
      return "landed on main";
    case "evicted":
      return "needs external repair";
    case "dequeued":
      return "removed manually";
  }
}

export function runtimeLabel(runtime: QueueRuntimeStatus): string {
  if (runtime.tickInProgress) {
    return "running";
  }
  if (runtime.lastTickOutcome === "idle") {
    return "idle";
  }
  return runtime.lastTickOutcome;
}

export function formatEventSummary(event: QueueEventSummary): string {
  const transition = event.fromStatus ? `${event.fromStatus} -> ${event.toStatus}` : `entered ${event.toStatus}`;
  return `#${event.prNumber} ${transition}${event.detail ? ` (${event.detail})` : ""}`;
}

export function formatEntryEvent(event: QueueEventRecord): string {
  const transition = event.fromStatus ? `${event.fromStatus} -> ${event.toStatus}` : `entered ${event.toStatus}`;
  return `${transition}${event.detail ? ` (${event.detail})` : ""}`;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
}

export function progressBar(current: number, total: number, width: number): string {
  if (total <= 0 || width <= 0) return "\u2591".repeat(width);
  const filled = Math.min(width, Math.round((current / total) * width));
  return "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

export function summarizeCheckNames(checks: CheckResult[], limit = 3): string {
  const names = [...new Set(checks.map((check) => check.name))];
  if (names.length === 0) return "unknown checks";
  if (names.length <= limit) return names.join(", ");
  return `${names.slice(0, limit).join(", ")} +${names.length - limit} more`;
}

export function summarizeQueueBlock(block: QueueBlockState | null | undefined): string | null {
  if (!block) return null;
  const failing = block.failingChecks.length > 0 ? `failing ${summarizeCheckNames(block.failingChecks)}` : null;
  const pending = block.pendingChecks.length > 0 ? `pending ${summarizeCheckNames(block.pendingChecks)}` : null;
  const suffix = [failing, pending].filter(Boolean).join("; ");
  return suffix ? `main broken: ${suffix}` : "main broken";
}
