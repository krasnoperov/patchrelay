import type { QueueEntryStatus, QueueEventRecord, QueueEventSummary, QueueRuntimeStatus } from "../types.ts";

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

export function statusColor(status: QueueEntryStatus): "yellow" | "cyan" | "magenta" | "green" | "red" | "gray" {
  switch (status) {
    case "queued":
      return "yellow";
    case "preparing_head":
      return "cyan";
    case "validating":
      return "magenta";
    case "merging":
      return "green";
    case "merged":
      return "green";
    case "evicted":
      return "red";
    case "dequeued":
      return "gray";
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

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}
