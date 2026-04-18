import type {
  ReviewAttemptRecord,
  ReviewQuillPendingReview,
  ReviewQuillRepoSummary,
  ReviewQuillWatchSnapshot,
} from "../types.ts";
import { getLatestAttemptsByPullRequest } from "../attempt-summary.ts";

export type DashboardTokenColor = "red" | "yellow" | "green" | "gray" | "white";

export type DashboardTokenKind =
  | "running"
  | "queued"
  | "approved"
  | "declined"
  | "error"
  | "cancelled"
  | "superseded"
  | "checks_running"
  | "checks_failed"
  | "checks_unknown";

export interface DashboardToken {
  prNumber: number;
  glyph: string;
  color: DashboardTokenColor;
  kind: DashboardTokenKind;
}

export interface DashboardPrEntry extends DashboardToken {
  phrase: string;
  summary?: string;
  title?: string;
  attemptId?: number;
  eventAt: number;
}

export interface DashboardRepo {
  repoId: string;
  repoFullName: string;
  tokens: DashboardToken[];
  entries: DashboardPrEntry[];
  latestActivityAt: number;
  hasActivity: boolean;
}

export interface DashboardModel {
  repos: DashboardRepo[];
  quietCount: number;
}

const DECIDED_WINDOW_MS = 24 * 60 * 60 * 1000;

const GLYPH: Record<DashboardTokenKind, string> = {
  running: "\u25cf",
  queued: "\u25cb",
  approved: "\u2713",
  declined: "\u2717",
  error: "\u26a0",
  cancelled: "\u2013",
  superseded: "\u21bb",
  checks_running: "\u25cf",
  checks_failed: "\u2717",
  checks_unknown: "\u25cb",
};

const COLOR: Record<DashboardTokenKind, DashboardTokenColor> = {
  running: "yellow",
  queued: "gray",
  approved: "green",
  declined: "red",
  error: "red",
  cancelled: "gray",
  superseded: "gray",
  checks_running: "yellow",
  checks_failed: "red",
  checks_unknown: "gray",
};

const PHRASE: Record<DashboardTokenKind, string> = {
  running: "reviewing",
  queued: "queued",
  approved: "approved",
  declined: "changes requested",
  error: "review errored",
  cancelled: "cancelled",
  superseded: "superseded",
  checks_running: "waiting for checks",
  checks_failed: "checks failed",
  checks_unknown: "waiting on checks",
};

export function phraseFor(kind: DashboardTokenKind): string {
  return PHRASE[kind];
}

function attemptKind(attempt: ReviewAttemptRecord): DashboardTokenKind {
  if (attempt.stale) {
    return "error";
  }
  if (attempt.status === "running") return "running";
  if (attempt.status === "queued") return "queued";
  if (attempt.status === "failed") return "error";
  if (attempt.status === "cancelled") return "cancelled";
  if (attempt.status === "superseded") return "superseded";
  if (attempt.status === "completed") {
    if (attempt.conclusion === "approved") return "approved";
    if (attempt.conclusion === "declined") return "declined";
    if (attempt.conclusion === "error") return "error";
    return "queued";
  }
  return "queued";
}

function pendingKind(reason: ReviewQuillPendingReview["reason"]): DashboardTokenKind {
  if (reason === "checks_running") return "checks_running";
  if (reason === "checks_failed") return "checks_failed";
  return "checks_unknown";
}

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function tokenSortOrder(kind: DashboardTokenKind): number {
  switch (kind) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "checks_running":
      return 2;
    case "checks_unknown":
      return 3;
    case "checks_failed":
      return 4;
    case "approved":
    case "declined":
    case "error":
      return 5;
    case "cancelled":
    case "superseded":
      return 6;
  }
}

function isDecided(kind: DashboardTokenKind): boolean {
  return kind === "approved" || kind === "declined" || kind === "error";
}

function isActive(kind: DashboardTokenKind): boolean {
  return (
    kind === "running"
    || kind === "queued"
    || kind === "checks_running"
    || kind === "checks_unknown"
    || kind === "checks_failed"
  );
}

export function buildDashboard(
  snapshot: ReviewQuillWatchSnapshot | null,
  opts: { windowMs?: number; now?: number } = {},
): DashboardModel {
  if (!snapshot) {
    return { repos: [], quietCount: 0 };
  }
  const windowMs = opts.windowMs ?? DECIDED_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowMs;

  const latestAttempts = getLatestAttemptsByPullRequest(snapshot.attempts);
  const attemptsByRepo = new Map<string, ReviewAttemptRecord[]>();
  for (const attempt of latestAttempts) {
    const list = attemptsByRepo.get(attempt.repoFullName);
    if (list) list.push(attempt);
    else attemptsByRepo.set(attempt.repoFullName, [attempt]);
  }

  const pendingByRepo = new Map<string, ReviewQuillPendingReview[]>();
  for (const pending of snapshot.pendingReviews ?? []) {
    const list = pendingByRepo.get(pending.repoFullName);
    if (list) list.push(pending);
    else pendingByRepo.set(pending.repoFullName, [pending]);
  }

  const repos: DashboardRepo[] = [];
  for (const repo of snapshot.repos) {
    const attempts = attemptsByRepo.get(repo.repoFullName) ?? [];
    const pending = pendingByRepo.get(repo.repoFullName) ?? [];
    const entries = repoEntries(attempts, pending, cutoff);
    const latestActivityAt = entries.reduce(
      (max, entry) => Math.max(max, entry.eventAt),
      0,
    );
    repos.push({
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      tokens: entries.map(({ prNumber, glyph, color, kind }) => ({ prNumber, glyph, color, kind })),
      entries,
      latestActivityAt,
      hasActivity: entries.length > 0,
    });
  }

  repos.sort((left, right) => {
    if (left.hasActivity !== right.hasActivity) {
      return left.hasActivity ? -1 : 1;
    }
    const leftActive = left.entries.some((entry) => isActive(entry.kind));
    const rightActive = right.entries.some((entry) => isActive(entry.kind));
    if (leftActive !== rightActive) {
      return leftActive ? -1 : 1;
    }
    if (left.latestActivityAt !== right.latestActivityAt) {
      return right.latestActivityAt - left.latestActivityAt;
    }
    return left.repoFullName.localeCompare(right.repoFullName);
  });

  const quietCount = repos.filter((repo) => !repo.hasActivity).length;
  return { repos, quietCount };
}

function repoEntries(
  attempts: ReviewAttemptRecord[],
  pending: ReviewQuillPendingReview[],
  cutoff: number,
): DashboardPrEntry[] {
  const byPr = new Map<number, DashboardPrEntry>();

  for (const attempt of attempts) {
    const kind = attemptKind(attempt);
    if (isDecided(kind) && timestamp(attempt.updatedAt) < cutoff) continue;
    if (kind === "cancelled" || kind === "superseded") continue;
    const entry: DashboardPrEntry = {
      prNumber: attempt.prNumber,
      glyph: GLYPH[kind],
      color: COLOR[kind],
      kind,
      phrase: PHRASE[kind],
      attemptId: attempt.id,
      eventAt: timestamp(attempt.updatedAt),
    };
    if (isDecided(kind) && attempt.summary) {
      entry.summary = attempt.summary;
    }
    if (attempt.prTitle) {
      entry.title = attempt.prTitle;
    }
    byPr.set(attempt.prNumber, entry);
  }

  for (const item of pending) {
    if (byPr.has(item.prNumber)) {
      const existing = byPr.get(item.prNumber)!;
      if (isActive(existing.kind)) {
        if (item.prTitle && !existing.title) existing.title = item.prTitle;
        continue;
      }
    }
    const kind = pendingKind(item.reason);
    const pendingEntry: DashboardPrEntry = {
      prNumber: item.prNumber,
      glyph: GLYPH[kind],
      color: COLOR[kind],
      kind,
      phrase: PHRASE[kind],
      eventAt: timestamp(item.updatedAt),
    };
    if (item.prTitle) pendingEntry.title = item.prTitle;
    byPr.set(item.prNumber, pendingEntry);
  }

  return [...byPr.values()].sort((left, right) => {
    const leftOrder = tokenSortOrder(left.kind);
    const rightOrder = tokenSortOrder(right.kind);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.eventAt !== right.eventAt) return right.eventAt - left.eventAt;
    return right.prNumber - left.prNumber;
  });
}

export function clipSummary(
  summary: string | undefined,
  opts: { maxLines?: number; width?: number } = {},
): string {
  if (!summary) return "";
  const maxLines = opts.maxLines ?? 3;
  const width = Math.max(20, opts.width ?? 80);

  const collapsed = summary.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";

  const sentenceRe = /[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g;
  const sentences = (collapsed.match(sentenceRe) ?? [collapsed])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  let buffer = "";
  for (const sentence of sentences) {
    const candidate = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
    if (wrapLines(candidate, width).length <= maxLines) {
      buffer = candidate;
    } else {
      break;
    }
  }

  if (buffer.length === 0) {
    const first = sentences[0] ?? collapsed;
    return wrapLines(first, width).slice(0, maxLines).join("\n");
  }
  return wrapLines(buffer, width).slice(0, maxLines).join("\n");
}

function wrapLines(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

export function repoSelector(repos: DashboardRepo[], selected: string | null): string | null {
  if (repos.length === 0) return null;
  if (selected && repos.some((repo) => repo.repoFullName === selected)) {
    return selected;
  }
  return repos[0]?.repoFullName ?? null;
}

export function stepRepo(repos: DashboardRepo[], selected: string | null, direction: 1 | -1): string | null {
  if (repos.length === 0) return null;
  const index = repos.findIndex((repo) => repo.repoFullName === selected);
  const currentIndex = index === -1 ? 0 : index;
  const nextIndex = (currentIndex + direction + repos.length) % repos.length;
  return repos[nextIndex]?.repoFullName ?? null;
}

export function findRepo(repos: DashboardRepo[], selected: string | null): DashboardRepo | null {
  if (!selected) return repos[0] ?? null;
  return repos.find((repo) => repo.repoFullName === selected) ?? repos[0] ?? null;
}
