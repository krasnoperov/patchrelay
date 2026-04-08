import type { QueueEntry, QueueWatchSnapshot } from "../types.ts";
import { buildChainEntries, buildDisplayEntries } from "./display-filter.ts";
import { formatDuration, humanStatus, nextStepLabel, relativeTime, summarizeQueueBlock } from "./format.ts";

export interface DashboardRepoConfig {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
}

export interface DashboardRepoState extends DashboardRepoConfig {
  snapshot: QueueWatchSnapshot | null;
  error: string | null;
  lastSnapshotReceivedAt: number | null;
}

export interface RepoHealthSummary {
  kind: "offline" | "blocked" | "stuck" | "attention" | "active" | "idle";
  label: string;
  color: "red" | "yellow" | "green" | "gray" | "cyan";
  detail: string;
}

export interface ClusterSummary {
  total: number;
  connected: number;
  blocked: number;
  stuck: number;
  attention: number;
  active: number;
}

const RECENT_EVICTION_MS = 60 * 60 * 1_000;
const STUCK_ENTRY_MS = 25 * 60 * 1_000;
const OFFLINE_STALE_MS = 10 * 1_000;

export function matchRepoRef(repo: DashboardRepoConfig, repoRef: string | undefined): boolean {
  if (!repoRef) {
    return false;
  }
  return repo.repoId === repoRef || repo.repoFullName === repoRef;
}

export function getVisibleEntries(snapshot: QueueWatchSnapshot | null, filter: "active" | "all"): QueueEntry[] {
  if (!snapshot) {
    return [];
  }
  return buildDisplayEntries(snapshot.entries, filter);
}

export function getChainEntries(snapshot: QueueWatchSnapshot | null): QueueEntry[] {
  if (!snapshot) {
    return [];
  }
  return buildChainEntries(snapshot.entries);
}

export function getActiveEntries(snapshot: QueueWatchSnapshot | null): QueueEntry[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.entries.filter((entry) => (
    entry.status !== "merged" && entry.status !== "evicted" && entry.status !== "dequeued"
  ));
}

export function getDefaultEntryId(
  snapshot: QueueWatchSnapshot | null,
  filter: "active" | "all",
  preferredPrNumber?: number | null,
): string | null {
  if (!snapshot) {
    return null;
  }
  const visibleEntries = getVisibleEntries(snapshot, filter);
  if (preferredPrNumber !== undefined && preferredPrNumber !== null) {
    const match = visibleEntries.find((entry) => entry.prNumber === preferredPrNumber)
      ?? snapshot.entries.find((entry) => entry.prNumber === preferredPrNumber);
    if (match) {
      return match.id;
    }
  }
  return snapshot.summary.headEntryId ?? visibleEntries[0]?.id ?? snapshot.entries[0]?.id ?? null;
}

export function getRepoHealth(repo: DashboardRepoState, now = Date.now()): RepoHealthSummary {
  const snapshot = repo.snapshot;
  const staleForMs = repo.lastSnapshotReceivedAt === null ? Infinity : now - repo.lastSnapshotReceivedAt;
  if (!snapshot || (repo.error && staleForMs > OFFLINE_STALE_MS)) {
    return {
      kind: "offline",
      label: "Offline",
      color: "red",
      detail: repo.error ?? "No queue data from merge-steward yet.",
    };
  }

  if (snapshot.queueBlock) {
    return {
      kind: "blocked",
      label: "Blocked",
      color: "yellow",
      detail: summarizeQueueBlock(snapshot.queueBlock) ?? `Waiting for ${snapshot.baseBranch} to recover.`,
    };
  }

  if (snapshot.runtime.lastTickOutcome === "failed") {
    return {
      kind: "stuck",
      label: "Stuck",
      color: "red",
      detail: snapshot.runtime.lastTickError?.split(/\r?\n/, 1)[0] ?? "The last reconcile tick failed.",
    };
  }

  const activeEntries = getActiveEntries(snapshot);
  const headEntry = activeEntries[0];
  if (headEntry) {
    const ageMs = now - new Date(headEntry.updatedAt).getTime();
    if (ageMs >= STUCK_ENTRY_MS) {
      return {
        kind: "stuck",
        label: "Stuck",
        color: "red",
        detail: `Head PR #${headEntry.prNumber} has not moved for ${relativeTime(headEntry.updatedAt)}.`,
      };
    }
  }

  const recentEvicted = snapshot.entries.find((entry) => (
    entry.status === "evicted"
    && now - new Date(entry.updatedAt).getTime() <= RECENT_EVICTION_MS
  ));
  if (recentEvicted) {
    return {
      kind: "attention",
      label: "Needs attention",
      color: "yellow",
      detail: `PR #${recentEvicted.prNumber} was evicted and needs repair before it can rejoin the queue.`,
    };
  }

  if (activeEntries.length > 0) {
    return {
      kind: "active",
      label: "Running",
      color: "cyan",
      detail: headEntry
        ? `Head PR #${headEntry.prNumber} is ${humanStatus(headEntry.status, headEntry)}.`
        : `${activeEntries.length} PRs are active in the queue.`,
    };
  }

  return {
    kind: "idle",
    label: "Idle",
    color: "green",
    detail: snapshot.summary.total > 0
      ? `No active queue work right now. Last activity was ${relativeTime(snapshot.entries[0]?.updatedAt)} ago.`
      : "No pull requests are queued right now.",
  };
}

export function getClusterSummary(repos: DashboardRepoState[], now = Date.now()): ClusterSummary {
  const initial: ClusterSummary = {
    total: repos.length,
    connected: 0,
    blocked: 0,
    stuck: 0,
    attention: 0,
    active: 0,
  };

  return repos.reduce((summary, repo) => {
    const health = getRepoHealth(repo, now);
    if (health.kind !== "offline") {
      summary.connected += 1;
    }
    if (health.kind === "blocked") {
      summary.blocked += 1;
    }
    if (health.kind === "stuck") {
      summary.stuck += 1;
    }
    if (health.kind === "attention") {
      summary.attention += 1;
    }
    if (repo.snapshot && getActiveEntries(repo.snapshot).length > 0) {
      summary.active += 1;
    }
    return summary;
  }, initial);
}

export function projectStatsSummary(snapshot: QueueWatchSnapshot | null): string {
  if (!snapshot) {
    return "No queue data yet.";
  }
  const { summary } = snapshot;
  const activeEntries = getActiveEntries(snapshot);
  const avgWaitMs = activeEntries.length > 0
    ? activeEntries.reduce((sum, entry) => sum + (Date.now() - new Date(entry.enqueuedAt).getTime()), 0) / activeEntries.length
    : 0;
  const parts = [
    `${summary.active} active`,
    `${summary.queued} waiting`,
    `${summary.validating} testing`,
    `${summary.merging} merging`,
  ];
  if (summary.evicted > 0) {
    parts.push(`${summary.evicted} need repair`);
  }
  if (avgWaitMs > 0) {
    parts.push(`avg wait ${formatDuration(avgWaitMs)}`);
  }
  return parts.join(" · ");
}

export function runtimeSummary(snapshot: QueueWatchSnapshot | null): string {
  if (!snapshot) {
    return "No runtime data yet.";
  }
  if (snapshot.runtime.tickInProgress) {
    return `Reconcile tick is running now. Last completed ${relativeTime(snapshot.runtime.lastTickCompletedAt)} ago.`;
  }
  if (snapshot.runtime.lastTickOutcome === "failed") {
    return `Last reconcile tick failed ${relativeTime(snapshot.runtime.lastTickCompletedAt ?? snapshot.runtime.lastTickStartedAt)} ago.`;
  }
  if (snapshot.runtime.lastTickCompletedAt) {
    return `Last reconcile tick ${snapshot.runtime.lastTickOutcome} ${relativeTime(snapshot.runtime.lastTickCompletedAt)} ago.`;
  }
  return "No reconcile tick has completed yet.";
}

export function describeEntry(entry: QueueEntry, options: { isHead: boolean; queueBlockSummary: string | null }): string {
  if (options.isHead && options.queueBlockSummary) {
    return options.queueBlockSummary;
  }
  if (entry.status === "queued") {
    if (entry.position > 1) {
      return `Waiting behind ${entry.position - 1} earlier PRs.`;
    }
    return "First in line and waiting for the next reconcile tick.";
  }
  const nextStep = nextStepLabel(entry.status, entry);
  return `${humanStatus(entry.status, entry)}: ${nextStep}.`;
}
