import type { QueueEntry, QueueEntryStatus, QueueWatchSnapshot } from "../types.ts";
import type { RepoRuntimeState } from "../admin-types.ts";
import { TERMINAL_STATUSES } from "../types.ts";
import { mergeWaitState } from "./format.ts";

export interface DashboardRepoConfig {
  repoId: string;
  repoFullName: string;
  baseBranch: string;
}

export interface DashboardRepoState extends DashboardRepoConfig {
  serviceState: RepoRuntimeState | "offline";
  serviceMessage: string | null;
  snapshot: QueueWatchSnapshot | null;
  error: string | null;
  lastSnapshotReceivedAt: number | null;
}

export type DashboardTokenColor = "red" | "yellow" | "green" | "gray" | "white";

export type DashboardTokenKind =
  | "running"
  | "queued"
  | "approved"
  | "declined"
  | "error"
  | "cancelled"
  | "superseded";

export interface DashboardToken {
  prNumber: number;
  glyph: string;
  color: DashboardTokenColor;
  kind: DashboardTokenKind;
}

export interface DashboardPrEntry extends DashboardToken {
  phrase: string;
  summary?: string;
  eventAt: number;
}

export interface DashboardRepo {
  repoId: string;
  repoFullName: string;
  tokens: DashboardToken[];
  entries: DashboardPrEntry[];
  latestActivityAt: number;
  hasActivity: boolean;
  offlineMessage: string | null;
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
};

const COLOR: Record<DashboardTokenKind, DashboardTokenColor> = {
  running: "yellow",
  queued: "gray",
  approved: "green",
  declined: "red",
  error: "red",
  cancelled: "gray",
  superseded: "gray",
};

function timestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isLaterEntry(left: QueueEntry, right: QueueEntry): boolean {
  if (left.position !== right.position) {
    return left.position > right.position;
  }
  return timestamp(left.updatedAt) >= timestamp(right.updatedAt);
}

function pickLatestPerPR(entries: QueueEntry[]): QueueEntry[] {
  const byPR = new Map<number, QueueEntry>();
  for (const entry of entries) {
    const existing = byPR.get(entry.prNumber);
    if (!existing || isLaterEntry(entry, existing)) {
      byPR.set(entry.prNumber, entry);
    }
  }
  return [...byPR.values()];
}

function entryKind(entry: QueueEntry): DashboardTokenKind {
  switch (entry.status) {
    case "queued":
      return "queued";
    case "preparing_head":
    case "validating":
    case "merging":
      return "running";
    case "merged":
      if (entry.postMergeStatus === "fail") return "declined";
      if (entry.postMergeStatus === "pending") return "running";
      return "approved";
    case "evicted":
      return "error";
    case "dequeued":
      return "cancelled";
  }
}

function entryPhrase(entry: QueueEntry, opts: { isHead: boolean; queueBlocked: boolean }): string {
  if (opts.isHead && opts.queueBlocked) {
    return "main broken";
  }
  switch (entry.status) {
    case "queued":
      return opts.isHead ? "queued" : "behind head";
    case "preparing_head":
      return entry.lastFailedBaseSha ? "has conflicts" : "preparing";
    case "validating":
      return "testing";
    case "merging": {
      const wait = mergeWaitState({ status: entry.status, waitDetail: entry.waitDetail });
      if (wait === "approval") return "waiting for approval";
      if (wait === "main") return "waiting for main";
      return "merging";
    }
    case "merged":
      if (entry.postMergeStatus === "fail") return "post-merge failed";
      if (entry.postMergeStatus === "pending") return "merged, post-merge pending";
      return "merged";
    case "evicted":
      return "evicted";
    case "dequeued":
      return "dequeued";
  }
}

function entrySummary(entry: QueueEntry): string | undefined {
  if (entry.status === "merged" && entry.postMergeStatus === "fail" && entry.postMergeSummary) {
    return entry.postMergeSummary;
  }
  return undefined;
}

function isActive(status: QueueEntryStatus): boolean {
  return !TERMINAL_STATUSES.includes(status);
}

function tokenSortOrder(kind: DashboardTokenKind): number {
  switch (kind) {
    case "running":
      return 0;
    case "queued":
      return 1;
    case "approved":
    case "declined":
    case "error":
      return 2;
    case "cancelled":
    case "superseded":
      return 3;
  }
}

function overrideKind(kind: DashboardTokenKind, override: "main_broken" | null): DashboardTokenKind {
  if (override === "main_broken") return "error";
  return kind;
}

function repoEntriesFromSnapshot(
  snapshot: QueueWatchSnapshot,
  cutoff: number,
): DashboardPrEntry[] {
  const latest = pickLatestPerPR(snapshot.entries);
  const head = latest
    .filter((entry) => isActive(entry.status))
    .sort((a, b) => a.position - b.position)[0] ?? null;
  const queueBlocked = Boolean(snapshot.queueBlock);

  const byPr = new Map<number, DashboardPrEntry>();

  for (const entry of latest) {
    const active = isActive(entry.status);
    if (!active && timestamp(entry.updatedAt) < cutoff) continue;
    if (entry.status === "dequeued") continue;
    const isHead = head !== null && entry.id === head.id;
    const rawKind = entryKind(entry);
    const kind = overrideKind(rawKind, isHead && queueBlocked ? "main_broken" : null);
    const glyph = GLYPH[kind];
    const color = COLOR[kind];
    const phrase = entryPhrase(entry, { isHead, queueBlocked });
    const item: DashboardPrEntry = {
      prNumber: entry.prNumber,
      glyph,
      color,
      kind,
      phrase,
      eventAt: timestamp(entry.updatedAt),
    };
    const summary = entrySummary(entry);
    if (summary) item.summary = summary;
    byPr.set(entry.prNumber, item);
  }

  return [...byPr.values()].sort((left, right) => {
    const leftOrder = tokenSortOrder(left.kind);
    const rightOrder = tokenSortOrder(right.kind);
    if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    if (left.eventAt !== right.eventAt) return right.eventAt - left.eventAt;
    return right.prNumber - left.prNumber;
  });
}

export function buildDashboard(
  repos: DashboardRepoState[],
  opts: { windowMs?: number; now?: number } = {},
): DashboardModel {
  const windowMs = opts.windowMs ?? DECIDED_WINDOW_MS;
  const now = opts.now ?? Date.now();
  const cutoff = now - windowMs;

  const mapped: DashboardRepo[] = repos.map((repo) => {
    const snapshot = repo.snapshot;
    if (!snapshot) {
      const message = repo.serviceState === "initializing"
        ? repo.serviceMessage ?? "initializing"
        : repo.serviceState === "failed"
          ? repo.serviceMessage ?? "init failed"
          : repo.error ?? "offline";
      return {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        tokens: [],
        entries: [],
        latestActivityAt: 0,
        hasActivity: false,
        offlineMessage: message,
      };
    }
    const entries = repoEntriesFromSnapshot(snapshot, cutoff);
    const latestActivityAt = entries.reduce((max, entry) => Math.max(max, entry.eventAt), 0);
    return {
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      tokens: entries.map(({ prNumber, glyph, color, kind }) => ({ prNumber, glyph, color, kind })),
      entries,
      latestActivityAt,
      hasActivity: entries.length > 0,
      offlineMessage: null,
    };
  });

  const active = mapped.filter((repo) => repo.hasActivity || repo.offlineMessage);
  active.sort((left, right) => {
    if (left.offlineMessage !== null && right.offlineMessage === null) return 1;
    if (right.offlineMessage !== null && left.offlineMessage === null) return -1;
    const leftHasActive = left.entries.some((entry) => entry.kind === "running" || entry.kind === "queued");
    const rightHasActive = right.entries.some((entry) => entry.kind === "running" || entry.kind === "queued");
    if (leftHasActive !== rightHasActive) return leftHasActive ? -1 : 1;
    if (left.latestActivityAt !== right.latestActivityAt) return right.latestActivityAt - left.latestActivityAt;
    return left.repoFullName.localeCompare(right.repoFullName);
  });

  const quietCount = mapped.length - active.length;
  return { repos: active, quietCount };
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
  if (selected && repos.some((repo) => repo.repoId === selected)) {
    return selected;
  }
  return repos[0]?.repoId ?? null;
}

export function stepRepo(repos: DashboardRepo[], selected: string | null, direction: 1 | -1): string | null {
  if (repos.length === 0) return null;
  const index = repos.findIndex((repo) => repo.repoId === selected);
  const currentIndex = index === -1 ? 0 : index;
  const nextIndex = (currentIndex + direction + repos.length) % repos.length;
  return repos[nextIndex]?.repoId ?? null;
}

export function findRepo(repos: DashboardRepo[], selected: string | null): DashboardRepo | null {
  if (!selected) return repos[0] ?? null;
  return repos.find((repo) => repo.repoId === selected) ?? repos[0] ?? null;
}

export function matchRepoRef(repo: DashboardRepoConfig, repoRef: string | undefined): boolean {
  if (!repoRef) return false;
  return repo.repoId === repoRef || repo.repoFullName === repoRef;
}

export function buildQueueSummary(entries: QueueEntry[]): QueueWatchSnapshot["summary"] {
  const summary: QueueWatchSnapshot["summary"] = {
    total: entries.length,
    active: 0,
    queued: 0,
    preparingHead: 0,
    validating: 0,
    merging: 0,
    merged: 0,
    evicted: 0,
    dequeued: 0,
    headEntryId: null,
    headPrNumber: null,
  };

  const activeEntries = entries.filter((entry) => !TERMINAL_STATUSES.includes(entry.status));
  if (activeEntries.length > 0) {
    summary.headEntryId = activeEntries[0]!.id;
    summary.headPrNumber = activeEntries[0]!.prNumber;
    summary.active = activeEntries.length;
  }

  for (const entry of entries) {
    switch (entry.status) {
      case "queued": summary.queued += 1; break;
      case "preparing_head": summary.preparingHead += 1; break;
      case "validating": summary.validating += 1; break;
      case "merging": summary.merging += 1; break;
      case "merged": summary.merged += 1; break;
      case "evicted": summary.evicted += 1; break;
      case "dequeued": summary.dequeued += 1; break;
    }
  }

  return summary;
}
