import { getThreadTurns } from "../../codex-thread-utils.ts";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { CodexThreadSummary, CodexThreadItem, StageReport } from "../../types.ts";

// ─── Timeline Entry Types ─────────────────────────────────────────

export interface TimelineEntry {
  id: string;
  at: string;
  kind: "feed" | "run-start" | "run-end" | "item" | "ci-checks";
  runId?: number | undefined;
  feed?: TimelineFeedPayload | undefined;
  run?: TimelineRunPayload | undefined;
  item?: TimelineItemPayload | undefined;
  ciChecks?: TimelineCIChecksPayload | undefined;
}

export interface TimelineFeedPayload {
  feedKind: string;
  status?: string | undefined;
  summary: string;
  detail?: string | undefined;
}

export interface TimelineRunPayload {
  runType: string;
  status: string;
  startedAt: string;
  endedAt?: string | undefined;
  threadId?: string | undefined;
}

export interface TimelineItemPayload {
  id: string;
  type: string;
  status: string;
  text?: string | undefined;
  command?: string | undefined;
  output?: string | undefined;
  exitCode?: number | undefined;
  durationMs?: number | undefined;
  changes?: unknown[] | undefined;
  toolName?: string | undefined;
}

export interface TimelineCIChecksPayload {
  checks: Array<{ name: string; status: string }>;
  overall: string;
}

// ─── Rehydration Input Types ──────────────────────────────────────

export interface TimelineRunInput {
  id: number;
  runType: string;
  status: string;
  startedAt: string;
  endedAt?: string | undefined;
  threadId?: string | undefined;
  report?: StageReport | undefined;
}

// ─── Build Timeline from Rehydration Data ─────────────────────────

export function buildTimelineFromRehydration(
  runs: TimelineRunInput[],
  feedEvents: OperatorFeedEvent[],
  liveThread: CodexThreadSummary | null | undefined,
  activeRunId: number | null | undefined,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const activeRun = activeRunId ? runs.find((run) => run.id === activeRunId) : undefined;

  // 1. Add run boundaries and items from reports
  for (const run of runs) {
    entries.push({
      id: `run-start-${run.id}`,
      at: run.startedAt,
      kind: "run-start",
      runId: run.id,
      run: { runType: run.runType, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, threadId: run.threadId },
    });

    if (run.endedAt) {
      entries.push({
        id: `run-end-${run.id}`,
        at: run.endedAt,
        kind: "run-end",
        runId: run.id,
        run: { runType: run.runType, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, threadId: run.threadId },
      });
    }

    if (run.id !== activeRunId && run.report) {
      entries.push(...itemsFromReport(run.id, run.report, run.startedAt, run.endedAt));
    }
  }

  // 2. Items from live thread (active run)
  if (liveThread && activeRunId) {
    entries.push(...itemsFromThread(activeRunId, liveThread, activeRun?.startedAt));
  }

  // 3. Feed events → feed entries + CI check aggregation
  entries.push(...feedEventsToEntries(feedEvents));

  // 4. Sort by timestamp, then by entry order for stability
  return sortTimelineEntries(entries);
}

export function reconcileTimelineFromRehydration(
  previousTimeline: TimelineEntry[],
  runs: TimelineRunInput[],
  feedEvents: OperatorFeedEvent[],
  liveThread: CodexThreadSummary | null | undefined,
  activeRunId: number | null | undefined,
): TimelineEntry[] {
  const rehydrated = buildTimelineFromRehydration(runs, feedEvents, liveThread, activeRunId);
  if (previousTimeline.length === 0) {
    return rehydrated;
  }

  const previousById = new Map(previousTimeline.map((entry) => [entry.id, entry]));
  const rehydratedIds = new Set(rehydrated.map((entry) => entry.id));
  const liveUserMessages = collectUserMessageCounts(rehydrated, activeRunId);
  const merged = rehydrated.map((entry) => mergeTimelineEntry(previousById.get(entry.id), entry));
  const carriedForward = previousTimeline.filter((entry) => {
    if (rehydratedIds.has(entry.id)) return false;
    return shouldCarryForwardEntry(entry, activeRunId, liveUserMessages);
  });

  return sortTimelineEntries([...merged, ...carriedForward]);
}

function kindOrder(kind: TimelineEntry["kind"]): number {
  switch (kind) {
    case "run-start": return 0;
    case "feed": return 1;
    case "ci-checks": return 2;
    case "item": return 3;
    case "run-end": return 4;
  }
}

// ─── Items from Report ────────────────────────────────────────────

function itemsFromReport(
  runId: number,
  report: StageReport,
  startedAt: string,
  endedAt: string | undefined,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  if (report.latestAssistantMessage) {
    entries.push({
      id: `report-${runId}-summary`,
      at: endedAt ?? startedAt,
      kind: "item",
      runId,
      item: { id: `report-${runId}-summary`, type: "agentMessage", status: "completed", text: report.latestAssistantMessage },
    });
  }

  return entries;
}

// ─── Items from Live Thread ───────────────────────────────────────

function itemsFromThread(
  runId: number,
  thread: CodexThreadSummary,
  runStartedAt?: string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  let itemIndex = 0;
  for (const turn of getThreadTurns(thread)) {
    for (const item of turn.items) {
      entries.push({
        id: `live-${item.id}`,
        at: liveItemTimestamp(runStartedAt, itemIndex),
        kind: "item",
        runId,
        item: materializeItem(item),
      });
      itemIndex += 1;
    }
  }
  return entries;
}

const LIVE_ITEM_FALLBACK_START_MS = Date.UTC(9999, 0, 1, 0, 0, 0, 0);

function liveItemTimestamp(runStartedAt: string | undefined, itemIndex: number): string {
  const baseMs = runStartedAt ? Date.parse(runStartedAt) : LIVE_ITEM_FALLBACK_START_MS;
  const stableBaseMs = Number.isFinite(baseMs) ? baseMs : LIVE_ITEM_FALLBACK_START_MS;
  return new Date(stableBaseMs + itemIndex).toISOString();
}

function materializeItem(item: CodexThreadItem): TimelineItemPayload {
  const r = item as Record<string, unknown>;
  const id = String(r.id ?? "unknown");
  const type = String(r.type ?? "unknown");
  const base: TimelineItemPayload = { id, type, status: "completed" };

  switch (type) {
    case "userMessage":
      return { ...base, text: extractUserMessageText(r.content) };
    case "agentMessage":
      return { ...base, text: String(r.text ?? "") };
    case "commandExecution":
      return {
        ...base,
        command: String(r.command ?? ""),
        status: String(r.status ?? "completed"),
        ...(typeof r.exitCode === "number" ? { exitCode: r.exitCode } : {}),
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
        ...(typeof r.aggregatedOutput === "string" ? { output: r.aggregatedOutput } : {}),
      };
    case "fileChange":
      return { ...base, status: String(r.status ?? "completed"), changes: Array.isArray(r.changes) ? r.changes as unknown[] : [] };
    case "mcpToolCall":
      return {
        ...base,
        status: String(r.status ?? "completed"),
        toolName: `${String(r.server ?? "")}/${String(r.tool ?? "")}`,
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
      };
    case "dynamicToolCall":
      return {
        ...base,
        status: String(r.status ?? "completed"),
        toolName: String(r.tool ?? ""),
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
      };
    case "plan":
      return { ...base, text: String(r.text ?? "") };
    case "reasoning":
      return { ...base, text: Array.isArray(r.summary) ? (r.summary as string[]).join("\n") : "" };
    default:
      return base;
  }
}

function mergeDefinedItemFields(base: TimelineItemPayload, patch: TimelineItemPayload): TimelineItemPayload {
  return {
    ...base,
    id: patch.id,
    type: patch.type,
    status: preferredItemStatus(base.status, patch.status),
    ...(mergePreferredString(base.text, patch.text) !== undefined ? { text: mergePreferredString(base.text, patch.text) } : {}),
    ...(patch.command !== undefined ? { command: patch.command } : {}),
    ...(mergePreferredString(base.output, patch.output) !== undefined ? { output: mergePreferredString(base.output, patch.output) } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.durationMs !== undefined || base.durationMs !== undefined
      ? { durationMs: preferredNumber(base.durationMs, patch.durationMs) }
      : {}),
    ...(patch.changes !== undefined || base.changes !== undefined
      ? { changes: preferredChanges(base.changes, patch.changes) }
      : {}),
    ...(patch.toolName !== undefined ? { toolName: patch.toolName } : {}),
  };
}

function mergeTimelineEntry(existing: TimelineEntry | undefined, incoming: TimelineEntry): TimelineEntry {
  if (!existing || existing.kind !== incoming.kind) {
    return incoming;
  }

  switch (incoming.kind) {
    case "item":
      return {
        ...incoming,
        at: existing.at,
        ...(existing.runId !== undefined && incoming.runId === undefined ? { runId: existing.runId } : {}),
        item: incoming.item && existing.item ? mergeDefinedItemFields(existing.item, incoming.item) : incoming.item,
      };
    case "run-start":
    case "run-end":
      return {
        ...incoming,
        at: existing.at,
        run: existing.run && incoming.run ? { ...existing.run, ...incoming.run } : incoming.run,
      };
    case "feed":
      return {
        ...incoming,
        at: existing.at,
        feed: existing.feed && incoming.feed ? { ...existing.feed, ...incoming.feed } : incoming.feed,
      };
    case "ci-checks":
      return {
        ...incoming,
        at: existing.at,
        ciChecks: incoming.ciChecks ?? existing.ciChecks,
      };
  }
}

function shouldCarryForwardEntry(
  entry: TimelineEntry,
  activeRunId: number | null | undefined,
  liveUserMessages: Map<string, number>,
): boolean {
  if (entry.kind !== "item" || entry.runId !== activeRunId) {
    return false;
  }

  if (entry.item?.id.startsWith("prompt-") === true) {
    const text = normalizePromptText(entry.item.text);
    return !text || !consumeUserMessageMatch(liveUserMessages, text);
  }

  return entry.item?.status === "inProgress";
}

function sortTimelineEntries(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const cmp = a.at.localeCompare(b.at);
    if (cmp !== 0) return cmp;
    // Within same timestamp: run-start before items, items before run-end
    const kindCmp = kindOrder(a.kind) - kindOrder(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.id.localeCompare(b.id);
  });
}

function preferredItemStatus(existing: string, incoming: string): string {
  return itemStatusRank(incoming) >= itemStatusRank(existing) ? incoming : existing;
}

function itemStatusRank(status: string): number {
  switch (status) {
    case "failed":
    case "completed":
    case "declined":
      return 2;
    case "inProgress":
      return 1;
    default:
      return 0;
  }
}

function mergePreferredString(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  return incoming.length >= existing.length ? incoming : existing;
}

function preferredNumber(existing: number | undefined, incoming: number | undefined): number | undefined {
  return incoming ?? existing;
}

function preferredChanges(existing: unknown[] | undefined, incoming: unknown[] | undefined): unknown[] | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  return incoming.length >= existing.length ? incoming : existing;
}

function collectUserMessageCounts(entries: TimelineEntry[], activeRunId: number | null | undefined): Map<string, number> {
  const texts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.kind !== "item" || entry.runId !== activeRunId || entry.item?.type !== "userMessage") {
      continue;
    }
    const text = normalizePromptText(entry.item.text);
    if (text) {
      texts.set(text, (texts.get(text) ?? 0) + 1);
    }
  }
  return texts;
}

function consumeUserMessageMatch(messages: Map<string, number>, text: string): boolean {
  const count = messages.get(text) ?? 0;
  if (count <= 0) {
    return false;
  }
  if (count === 1) {
    messages.delete(text);
  } else {
    messages.set(text, count - 1);
  }
  return true;
}

function normalizePromptText(text: string | undefined): string | null {
  const normalized = text?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function extractUserMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") return undefined;
      const value = (entry as Record<string, unknown>).text;
      return typeof value === "string" ? value : undefined;
    })
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
}

// ─── Feed Events to Timeline Entries ──────────────────────────────

function feedEventsToEntries(feedEvents: OperatorFeedEvent[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const ciAggregator = new CICheckAggregator();

  for (const event of feedEvents) {
    // GitHub check events get aggregated
    if (event.kind === "github" && (event.status === "check_passed" || event.status === "check_failed") && event.detail) {
      const ciEntry = ciAggregator.add(event);
      if (ciEntry) {
        // Replace the last ci-checks entry if it was updated
        const lastIdx = entries.findLastIndex((e) => e.kind === "ci-checks" && e.id === ciEntry.id);
        if (lastIdx >= 0) {
          entries[lastIdx] = ciEntry;
        } else {
          entries.push(ciEntry);
        }
      }
      continue;
    }

    entries.push({
      id: `feed-${event.id}`,
      at: event.at,
      kind: "feed",
      feed: {
        feedKind: event.kind,
        ...(event.status ? { status: event.status } : {}),
        summary: event.summary,
        ...(event.detail ? { detail: event.detail } : {}),
      },
    });
  }

  return entries;
}

// ─── CI Check Aggregation ─────────────────────────────────────────

const CI_CHECK_WINDOW_MS = 60_000;

class CICheckAggregator {
  private currentGroup: { id: string; at: string; checks: Map<string, string>; windowStart: number } | null = null;
  private groupCounter = 0;

  add(event: OperatorFeedEvent): TimelineEntry | undefined {
    const name = event.detail ?? "unknown";
    const status = event.status === "check_passed" ? "passed" : "failed";
    const eventMs = new Date(event.at).getTime();

    if (this.currentGroup && eventMs - this.currentGroup.windowStart < CI_CHECK_WINDOW_MS) {
      this.currentGroup.checks.set(name, status);
      return this.toEntry();
    }

    this.groupCounter++;
    this.currentGroup = {
      id: `ci-checks-${this.groupCounter}`,
      at: event.at,
      checks: new Map([[name, status]]),
      windowStart: eventMs,
    };
    return this.toEntry();
  }

  private toEntry(): TimelineEntry {
    const group = this.currentGroup!;
    const checks = [...group.checks.entries()].map(([name, status]) => ({ name, status }));
    const overall = checks.every((c) => c.status === "passed") ? "passed"
      : checks.some((c) => c.status === "failed") ? "failed"
      : "pending";
    return {
      id: group.id,
      at: group.at,
      kind: "ci-checks",
      ciChecks: { checks, overall },
    };
  }
}

// ─── Live Append Helpers ──────────────────────────────────────────

export function appendFeedToTimeline(timeline: TimelineEntry[], event: OperatorFeedEvent): TimelineEntry[] {
  // GitHub check events: aggregate into existing ci-checks entry
  if (event.kind === "github" && (event.status === "check_passed" || event.status === "check_failed") && event.detail) {
    return aggregateCICheckIntoTimeline(timeline, event);
  }

  return [...timeline, {
    id: `feed-${event.id}`,
    at: event.at,
    kind: "feed" as const,
    feed: {
      feedKind: event.kind,
      ...(event.status ? { status: event.status } : {}),
      summary: event.summary,
      ...(event.detail ? { detail: event.detail } : {}),
    },
  }];
}

function aggregateCICheckIntoTimeline(timeline: TimelineEntry[], event: OperatorFeedEvent): TimelineEntry[] {
  const name = event.detail ?? "unknown";
  const status = event.status === "check_passed" ? "passed" : "failed";
  const eventMs = new Date(event.at).getTime();

  // Find the most recent ci-checks entry within the window
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i]!;
    if (entry.kind === "ci-checks" && entry.ciChecks) {
      const entryMs = new Date(entry.at).getTime();
      if (eventMs - entryMs < CI_CHECK_WINDOW_MS) {
        const updatedChecks = [...entry.ciChecks.checks.filter((c) => c.name !== name), { name, status }];
        const overall = updatedChecks.every((c) => c.status === "passed") ? "passed"
          : updatedChecks.some((c) => c.status === "failed") ? "failed"
          : "pending";
        const updated = [...timeline];
        updated[i] = { ...entry, ciChecks: { checks: updatedChecks, overall } };
        return updated;
      }
      break;
    }
  }

  // No recent ci-checks entry; create new one
  return [...timeline, {
    id: `ci-checks-live-${event.id}`,
    at: event.at,
    kind: "ci-checks" as const,
    ciChecks: { checks: [{ name, status }], overall: status },
  }];
}

export function appendCodexItemToTimeline(
  timeline: TimelineEntry[],
  params: Record<string, unknown>,
  activeRunId: number | null,
): TimelineEntry[] {
  const itemObj = params.item as Record<string, unknown> | undefined;
  if (!itemObj) return timeline;
  const id = typeof itemObj.id === "string" ? itemObj.id : "unknown";
  const type = typeof itemObj.type === "string" ? itemObj.type : "unknown";
  const status = typeof itemObj.status === "string" ? itemObj.status : "inProgress";

  const item: TimelineItemPayload = { id, type, status };
  if ((type === "agentMessage" || type === "userMessage") && typeof itemObj.text === "string") item.text = itemObj.text;
  if (type === "commandExecution") {
    const cmd = itemObj.command;
    item.command = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : undefined;
  }
  if (type === "mcpToolCall") {
    item.toolName = `${String(itemObj.server ?? "")}/${String(itemObj.tool ?? "")}`;
  }
  if (type === "dynamicToolCall") {
    item.toolName = typeof itemObj.tool === "string" ? itemObj.tool : undefined;
  }

  return [...timeline, {
    id: `live-${id}`,
    at: new Date().toISOString(),
    kind: "item" as const,
    runId: activeRunId ?? undefined,
    item,
  }];
}

export function completeCodexItemInTimeline(
  timeline: TimelineEntry[],
  params: Record<string, unknown>,
): TimelineEntry[] {
  const itemObj = params.item as Record<string, unknown> | undefined;
  if (!itemObj) return timeline;
  const id = typeof itemObj.id === "string" ? itemObj.id : undefined;
  if (!id) return timeline;

  const status = typeof itemObj.status === "string" ? itemObj.status : "completed";
  const exitCode = typeof itemObj.exitCode === "number" ? itemObj.exitCode : undefined;
  const durationMs = typeof itemObj.durationMs === "number" ? itemObj.durationMs : undefined;
  const text = typeof itemObj.text === "string" ? itemObj.text : undefined;
  const changes = Array.isArray(itemObj.changes) ? itemObj.changes as unknown[] : undefined;

  return timeline.map((entry) => {
    if (entry.kind !== "item" || entry.item?.id !== id) return entry;
    return {
      ...entry,
      item: {
        ...entry.item,
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(changes !== undefined ? { changes } : {}),
      },
    };
  });
}

export function appendDeltaToTimelineItem(
  timeline: TimelineEntry[],
  itemId: string,
  field: "text" | "output",
  delta: string,
): TimelineEntry[] {
  return timeline.map((entry) => {
    if (entry.kind !== "item" || entry.item?.id !== itemId) return entry;
    return {
      ...entry,
      item: { ...entry.item, [field]: (entry.item[field] ?? "") + delta },
    };
  });
}
