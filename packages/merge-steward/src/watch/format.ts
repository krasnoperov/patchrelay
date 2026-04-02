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

export function humanStatus(status: QueueEntryStatus, entry?: { lastFailedBaseSha: string | null; specBranch: string | null }): string {
  switch (status) {
    case "queued":
      return "waiting in queue";
    case "preparing_head":
      if (entry?.lastFailedBaseSha) return "has conflicts";
      return "preparing";
    case "validating":
      return "testing";
    case "merging":
      return "merging";
    case "merged":
      return "merged";
    case "evicted":
      return "needs repair";
    case "dequeued":
      return "removed";
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

export function nextStepLabel(status: QueueEntryStatus, entry?: { lastFailedBaseSha: string | null; specBasedOn: string | null }): string {
  switch (status) {
    case "queued":
      return "starting shortly";
    case "preparing_head":
      if (entry?.lastFailedBaseSha) return "conflicts with main, will retry when queue advances";
      return "building test branch with PRs ahead";
    case "validating":
      return entry?.specBasedOn
        ? "CI running, tested together with PRs ahead"
        : "CI running on combined changes";
    case "merging":
      return "landing on main";
    case "merged":
      return "landed on main";
    case "evicted":
      return "needs branch repair before re-admission";
    case "dequeued":
      return "removed from queue";
  }
}

/** Describe the spec chain for a queue entry. */
export function specChainLabel(entry: { specBranch: string | null; specBasedOn: string | null; specSha: string | null }, allEntries: Array<{ id: string; prNumber: number; specBranch: string | null }>): string {
  if (!entry.specBranch) return "no spec yet";
  const parent = entry.specBasedOn
    ? allEntries.find((e) => e.id === entry.specBasedOn)
    : null;
  const base = parent
    ? `#${parent.prNumber}`
    : "main";
  return `${shortSha(entry.specSha)} \u2190 ${base}`;
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

const STATUS_DISPLAY: Record<string, string> = {
  queued: "queued",
  preparing_head: "preparing",
  validating: "testing",
  merging: "merging",
  merged: "merged",
  evicted: "evicted",
  dequeued: "removed",
};

function displayStatus(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

/** Truncate hex strings longer than 12 chars (SHAs, run IDs) to 8 chars. */
function shortenHashes(text: string): string {
  return text.replace(/\b[0-9a-f]{13,}\b/g, (match) => match.slice(0, 8));
}

export function formatEventSummary(event: QueueEventSummary): string {
  const from = event.fromStatus ? displayStatus(event.fromStatus) : null;
  const to = displayStatus(event.toStatus);
  const transition = from ? `${from} \u2192 ${to}` : to;
  const detail = event.detail ? ` (${shortenHashes(event.detail)})` : "";
  return `#${event.prNumber} ${transition}${detail}`;
}

export function formatEntryEvent(event: QueueEventRecord): string {
  const from = event.fromStatus ? displayStatus(event.fromStatus) : null;
  const to = displayStatus(event.toStatus);
  const transition = from ? `${from} \u2192 ${to}` : to;
  const detail = event.detail ? ` (${shortenHashes(event.detail)})` : "";
  return `${transition}${detail}`;
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

/** CI status icon for the spec chain summary line. */
export function ciStatusIcon(entry: { status: QueueEntryStatus; ciRunId: string | null }): { icon: string; color: string } {
  switch (entry.status) {
    case "merged": return { icon: "\u2713", color: "green" };     // ✓
    case "merging": return { icon: "\u2713", color: "cyan" };     // ✓
    case "evicted": return { icon: "\u2717", color: "red" };      // ✗
    case "dequeued": return { icon: "\u2012", color: "gray" };    // ‒
    case "validating":
      return entry.ciRunId ? { icon: "\u25cf", color: "cyan" } : { icon: "\u25cb", color: "gray" };  // ● or ○
    case "preparing_head":
      return { icon: "\u25cb", color: "yellow" };                  // ○
    case "queued":
    default:
      return { icon: "\u25cb", color: "gray" };                    // ○
  }
}

export function summarizeQueueBlock(block: QueueBlockState | null | undefined): string | null {
  if (!block) return null;
  const failing = block.failingChecks.length > 0 ? `failing ${summarizeCheckNames(block.failingChecks)}` : null;
  const pending = block.pendingChecks.length > 0 ? `pending ${summarizeCheckNames(block.pendingChecks)}` : null;
  const suffix = [failing, pending].filter(Boolean).join("; ");
  return suffix ? `main broken: ${suffix}` : "main broken";
}
