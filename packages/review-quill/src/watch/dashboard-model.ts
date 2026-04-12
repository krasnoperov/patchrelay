import type { ReviewAttemptRecord, ReviewQuillRepoSummary, ReviewQuillWatchSnapshot, WebhookEventRecord } from "../types.ts";
import { getLatestAttemptsByPullRequest } from "../attempt-summary.ts";
import { attemptLabel, relativeTime } from "./format.ts";

export interface RepoHealthSummary {
  kind: "offline" | "stuck" | "attention" | "active" | "idle";
  label: string;
  color: "red" | "yellow" | "green" | "gray" | "cyan";
  detail: string;
}

export interface ClusterSummary {
  total: number;
  connected: number;
  active: number;
  queued: number;
  stuck: number;
  attention: number;
}

export interface RecentActivityItem {
  key: string;
  age: string;
  message: string;
}

function repoAttempts(snapshot: ReviewQuillWatchSnapshot | null, repo: ReviewQuillRepoSummary): ReviewAttemptRecord[] {
  if (!snapshot) {
    return [];
  }
  return getLatestAttemptsByPullRequest(snapshot.attempts).filter((attempt) => attempt.repoFullName === repo.repoFullName);
}

function repoWebhooks(snapshot: ReviewQuillWatchSnapshot | null, repo: ReviewQuillRepoSummary): WebhookEventRecord[] {
  if (!snapshot) {
    return [];
  }
  return snapshot.recentWebhooks.filter((event) => event.repoFullName === repo.repoFullName);
}

function repoAttemptStats(snapshot: ReviewQuillWatchSnapshot | null, repo: ReviewQuillRepoSummary): {
  queued: number;
  running: number;
  failed: number;
  stale: number;
} {
  const attempts = repoAttempts(snapshot, repo);
  return {
    queued: attempts.filter((attempt) => attempt.status === "queued" && !attempt.stale).length,
    running: attempts.filter((attempt) => attempt.status === "running" && !attempt.stale).length,
    failed: attempts.filter((attempt) => attempt.status === "failed").length,
    stale: attempts.filter((attempt) => attempt.stale).length,
  };
}

function summarizeWebhookBurst(events: WebhookEventRecord[]): string | null {
  if (events.length === 0) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.eventType, (counts.get(event.eventType) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([eventType, count]) => `${count} ${eventType}`);
  return parts.join(", ");
}

function latestAttemptDetail(attempt: ReviewAttemptRecord): string {
  if (attempt.status === "completed" && attempt.conclusion === "approved") {
    return `No review work right now. Latest stored review result: PR #${attempt.prNumber} approved ${relativeTime(attempt.updatedAt)} ago.`;
  }
  if (attempt.status === "completed" && attempt.conclusion === "declined") {
    return `No review work right now. Latest stored review result: PR #${attempt.prNumber} requested changes ${relativeTime(attempt.updatedAt)} ago.`;
  }
  if (attempt.status === "superseded") {
    return `No review work right now. Latest stored review attempt for PR #${attempt.prNumber} was superseded ${relativeTime(attempt.updatedAt)} ago.`;
  }
  if (attempt.status === "cancelled") {
    return `No review work right now. Latest stored review attempt for PR #${attempt.prNumber} was cancelled ${relativeTime(attempt.updatedAt)} ago.`;
  }
  return `No review work right now. Last activity was ${relativeTime(attempt.updatedAt)} ago.`;
}

function hasRepoActivityAfterAttempt(attempt: ReviewAttemptRecord, events: WebhookEventRecord[]): boolean {
  const attemptUpdatedAt = new Date(attempt.updatedAt).getTime();
  return events.some((event) => new Date(event.receivedAt).getTime() > attemptUpdatedAt);
}

export function getRepoHealth(snapshot: ReviewQuillWatchSnapshot | null, repo: ReviewQuillRepoSummary): RepoHealthSummary {
  if (!snapshot) {
    return {
      kind: "offline",
      label: "Offline",
      color: "red",
      detail: "No review-quill data yet.",
    };
  }

  const attempts = repoAttempts(snapshot, repo);
  const stale = attempts.find((attempt) => attempt.stale);
  if (stale) {
    return {
      kind: "stuck",
      label: "Stuck",
      color: "red",
      detail: `PR #${stale.prNumber} is stale: ${stale.staleReason ?? "review worker stopped making progress."}`,
    };
  }

  const running = attempts.filter((attempt) => attempt.status === "running");
  const queued = attempts.filter((attempt) => attempt.status === "queued");
  if (running.length > 0) {
    return {
      kind: "active",
      label: "Reviewing",
      color: "cyan",
      detail: queued.length > 0
        ? `Reviewing PR #${running[0]!.prNumber} with ${queued.length} queued behind the runner.`
        : `Reviewing PR #${running[0]!.prNumber}.`,
    };
  }
  if (queued.length > 0) {
    return {
      kind: "active",
      label: "Queued",
      color: "yellow",
      detail: queued.length === 1
        ? `PR #${queued[0]!.prNumber} is queued for review when the runner is free.`
        : `${queued.length} pull requests are queued for review.`,
    };
  }

  const failed = attempts.find((attempt) => attempt.status === "failed");
  if (failed) {
    const reason = failed.summary?.split(/\r?\n/, 1)[0] ?? "Review attempt failed.";
    return {
      kind: "attention",
      label: "Needs attention",
      color: "yellow",
      detail: `PR #${failed.prNumber} needs a retry: ${reason}`,
    };
  }

  const latest = attempts[0];
  if (latest) {
    const webhooks = repoWebhooks(snapshot, repo);
    if (hasRepoActivityAfterAttempt(latest, webhooks)) {
      const latestResult = latest.status === "completed"
        ? latest.conclusion === "approved"
          ? `Latest stored review result: PR #${latest.prNumber} approved ${relativeTime(latest.updatedAt)} ago.`
          : latest.conclusion === "declined"
            ? `Latest stored review result: PR #${latest.prNumber} requested changes ${relativeTime(latest.updatedAt)} ago.`
            : `Latest stored review result for PR #${latest.prNumber} finished ${relativeTime(latest.updatedAt)} ago.`
        : `Latest stored review activity was on PR #${latest.prNumber} ${relativeTime(latest.updatedAt)} ago.`;
      return {
        kind: "idle",
        label: "Idle",
        color: "green",
        detail: `${latestResult} Recent repo activity has not produced newer eligible review work yet.`,
      };
    }
    return {
      kind: "idle",
      label: "Idle",
      color: "green",
      detail: latestAttemptDetail(latest),
    };
  }

  const webhooks = repoWebhooks(snapshot, repo);
  const burst = summarizeWebhookBurst(webhooks);
  if (burst && webhooks[0]) {
    return {
      kind: "idle",
      label: "Idle",
      color: "green",
      detail: `No review attempts yet. Recent wakeups: ${burst} over the last ${relativeTime(webhooks[0].receivedAt)}.`,
    };
  }

  return {
    kind: "idle",
    label: "Idle",
    color: "green",
    detail: "No review activity recorded yet.",
  };
}

export function getClusterSummary(snapshot: ReviewQuillWatchSnapshot | null): ClusterSummary {
  if (!snapshot) {
    return {
      total: 0,
      connected: 0,
      active: 0,
      queued: 0,
      stuck: 0,
      attention: 0,
    };
  }

  return snapshot.repos.reduce<ClusterSummary>((summary, repo) => {
    const health = getRepoHealth(snapshot, repo);
    summary.total += 1;
    summary.connected += 1;
    if (health.kind === "active") {
      summary.active += 1;
    }
    if (repo.queuedAttempts > 0) {
      summary.queued += 1;
    }
    if (health.kind === "stuck") {
      summary.stuck += 1;
    }
    if (health.kind === "attention") {
      summary.attention += 1;
    }
    return summary;
  }, {
    total: 0,
    connected: 0,
    active: 0,
    queued: 0,
    stuck: 0,
    attention: 0,
  });
}

export function projectStatsSummary(snapshot: ReviewQuillWatchSnapshot | null, repo: ReviewQuillRepoSummary): string {
  const stats = repoAttemptStats(snapshot, repo);
  const failedSuffix = stats.failed > 0 ? ` · ${stats.failed} failed` : "";
  const staleSuffix = stats.stale > 0 ? ` · ${stats.stale} stale` : "";
  return `${stats.running} active · ${stats.queued} queued${failedSuffix}${staleSuffix}`;
}

export function getReviewQueueText(snapshot: ReviewQuillWatchSnapshot | null, repo: ReviewQuillRepoSummary): string {
  const attempts = repoAttempts(snapshot, repo)
    .filter((attempt) => (attempt.status === "running" || attempt.status === "queued") && !attempt.stale)
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "running" ? -1 : 1;
      }
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    });
  if (attempts.length === 0) {
    const staleAttempts = repoAttempts(snapshot, repo).filter((attempt) => attempt.stale);
    if (staleAttempts.length > 0) {
      return `${staleAttempts.length} stale attempt${staleAttempts.length === 1 ? "" : "s"} need cleanup`;
    }
    return "no eligible review work";
  }
  return attempts.map((attempt) => `#${attempt.prNumber} ${attempt.status}`).join("  ");
}

export function getRecentActivity(snapshot: ReviewQuillWatchSnapshot | null, repoLookup: Map<string, ReviewQuillRepoSummary>): RecentActivityItem[] {
  if (!snapshot) {
    return [];
  }

  const attemptItems = getLatestAttemptsByPullRequest(snapshot.attempts)
    .slice(0, 6)
    .map((attempt) => {
      const repo = repoLookup.get(attempt.repoFullName);
      const repoLabel = repo?.repoId ?? attempt.repoFullName;
      return {
        key: `attempt:${attempt.id}`,
        age: relativeTime(attempt.updatedAt),
        message: `${repoLabel} PR #${attempt.prNumber} ${attemptLabel(attempt)}`,
      };
    });
  if (attemptItems.length > 0) {
    return attemptItems;
  }

  const grouped = new Map<string, WebhookEventRecord[]>();
  for (const event of snapshot.recentWebhooks) {
    const key = event.repoFullName ?? "unknown";
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      grouped.set(key, [event]);
    }
  }
  return [...grouped.entries()]
    .sort((left, right) => {
      const leftTs = new Date(left[1][0]?.receivedAt ?? 0).getTime();
      const rightTs = new Date(right[1][0]?.receivedAt ?? 0).getTime();
      return rightTs - leftTs;
    })
    .slice(0, 6)
    .map(([repoFullName, events]) => {
      const repo = repoLookup.get(repoFullName);
      return {
        key: `webhook:${repoFullName}`,
        age: relativeTime(events[0]?.receivedAt),
        message: `${repo?.repoId ?? repoFullName} wakeups: ${summarizeWebhookBurst(events) ?? "activity"}`,
      };
    });
}
