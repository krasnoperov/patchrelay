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
  events?: TimelineThreadEventInput[] | undefined;
}

export interface TimelineThreadEventInput {
  id: number;
  method: string;
  createdAt: string;
  parsedEvent?: Record<string, unknown> | undefined;
}

// ─── Build Timeline from Rehydration Data ─────────────────────────

export function buildTimelineFromRehydration(
  runs: TimelineRunInput[],
  feedEvents: OperatorFeedEvent[],
  liveThread: CodexThreadSummary | null | undefined,
  activeRunId: number | null | undefined,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  // 1. Add run boundaries and items from reports
  for (const run of runs) {
    entries.push({
      id: `run-start-${run.id}`,
      at: run.startedAt,
      kind: "run-start",
      runId: run.id,
      run: { runType: run.runType, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt },
    });

    if (run.endedAt) {
      entries.push({
        id: `run-end-${run.id}`,
        at: run.endedAt,
        kind: "run-end",
        runId: run.id,
        run: { runType: run.runType, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt },
      });
    }

    // Items from completed run event history, with report fallback
    if (run.id !== activeRunId) {
      if (run.events && run.events.length > 0) {
        entries.push(...itemsFromThreadEvents(run.id, run.events));
      } else if (run.report) {
        entries.push(...itemsFromReport(run.id, run.report, run.startedAt, run.endedAt));
      }
    }
  }

  // 2. Items from live thread (active run)
  if (liveThread && activeRunId) {
    entries.push(...itemsFromThread(activeRunId, liveThread));
  }

  // 3. Feed events → feed entries + CI check aggregation
  entries.push(...feedEventsToEntries(feedEvents));

  // 4. Sort by timestamp, then by entry order for stability
  entries.sort((a, b) => {
    const cmp = a.at.localeCompare(b.at);
    if (cmp !== 0) return cmp;
    // Within same timestamp: run-start before items, items before run-end
    const kindCmp = kindOrder(a.kind) - kindOrder(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.id.localeCompare(b.id);
  });

  return entries;
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
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : start + 60000;
  let idx = 0;
  const total = report.commands.length + report.assistantMessages.length + report.toolCalls.length;

  for (const msg of report.assistantMessages) {
    entries.push({
      id: `report-${runId}-msg-${idx}`,
      at: syntheticTimestamp(start, end, idx, total),
      kind: "item",
      runId,
      item: { id: `report-${runId}-msg-${idx}`, type: "agentMessage", status: "completed", text: msg },
    });
    idx++;
  }

  for (const cmd of report.commands) {
    entries.push({
      id: `report-${runId}-cmd-${idx}`,
      at: syntheticTimestamp(start, end, idx, total),
      kind: "item",
      runId,
      item: {
        id: `report-${runId}-cmd-${idx}`,
        type: "commandExecution",
        status: "completed",
        command: cmd.command,
        ...(typeof cmd.exitCode === "number" ? { exitCode: cmd.exitCode } : {}),
        ...(typeof cmd.durationMs === "number" ? { durationMs: cmd.durationMs } : {}),
      },
    });
    idx++;
  }

  for (const tool of report.toolCalls) {
    entries.push({
      id: `report-${runId}-tool-${idx}`,
      at: syntheticTimestamp(start, end, idx, total),
      kind: "item",
      runId,
      item: {
        id: `report-${runId}-tool-${idx}`,
        type: tool.type === "mcp" ? "mcpToolCall" : "dynamicToolCall",
        status: "completed",
        toolName: tool.name,
        ...(typeof tool.durationMs === "number" ? { durationMs: tool.durationMs } : {}),
      },
    });
    idx++;
  }

  if (report.fileChanges.length > 0) {
    entries.push({
      id: `report-${runId}-files`,
      at: syntheticTimestamp(start, end, idx, total),
      kind: "item",
      runId,
      item: {
        id: `report-${runId}-files`,
        type: "fileChange",
        status: "completed",
        changes: report.fileChanges,
      },
    });
  }

  return entries;
}

function syntheticTimestamp(startMs: number, endMs: number, index: number, total: number): string {
  if (total <= 1) return new Date(startMs).toISOString();
  const fraction = index / (total - 1);
  return new Date(startMs + fraction * (endMs - startMs)).toISOString();
}

// ─── Items from Live Thread ───────────────────────────────────────

function itemsFromThread(runId: number, thread: CodexThreadSummary): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      entries.push({
        id: `live-${item.id}`,
        at: new Date().toISOString(), // live items don't have timestamps; they'll sort to the end
        kind: "item",
        runId,
        item: materializeItem(item),
      });
    }
  }
  return entries;
}

function materializeItem(item: CodexThreadItem): TimelineItemPayload {
  const r = item as Record<string, unknown>;
  const id = String(r.id ?? "unknown");
  const type = String(r.type ?? "unknown");
  const base: TimelineItemPayload = { id, type, status: "completed" };

  switch (type) {
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

function itemsFromThreadEvents(runId: number, events: TimelineThreadEventInput[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const event of events) {
    const params = event.parsedEvent;
    if (!params) continue;

    switch (event.method) {
      case "item/started": {
        const item = materializeNotificationItem(params.item);
        if (!item) break;
        entries.push({
          id: `event-${event.id}-item-${item.id}`,
          at: event.createdAt,
          kind: "item",
          runId,
          item,
        });
        break;
      }

      case "item/completed": {
        const item = materializeNotificationItem(params.item);
        if (!item) break;
        const existing = findTimelineItem(entries, item.id);
        if (existing) {
          existing.item = mergeDefinedItemFields(existing.item!, item);
        } else {
          entries.push({
            id: `event-${event.id}-item-${item.id}`,
            at: event.createdAt,
            kind: "item",
            runId,
            item,
          });
        }
        break;
      }

      case "item/agentMessage/delta":
      case "item/plan/delta":
      case "item/reasoning/summaryTextDelta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : undefined;
        if (!itemId || !delta) break;
        const existing = findTimelineItem(entries, itemId);
        const target = existing ?? createReplayPlaceholder(entries, runId, event.createdAt, event.id, itemId, inferItemTypeFromDeltaMethod(event.method));
        target.item = {
          ...target.item!,
          text: `${target.item?.text ?? ""}${delta}`,
        };
        break;
      }

      case "item/commandExecution/outputDelta": {
        const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
        const delta = typeof params.delta === "string" ? params.delta : undefined;
        if (!itemId || !delta) break;
        const existing = findTimelineItem(entries, itemId);
        const target = existing ?? createReplayPlaceholder(entries, runId, event.createdAt, event.id, itemId, "commandExecution");
        target.item = {
          ...target.item!,
          output: `${target.item?.output ?? ""}${delta}`,
        };
        break;
      }
    }
  }

  return entries;
}

function findTimelineItem(entries: TimelineEntry[], itemId: string): TimelineEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === "item" && entry.item?.id === itemId) {
      return entry;
    }
  }
  return undefined;
}

function createReplayPlaceholder(
  entries: TimelineEntry[],
  runId: number,
  at: string,
  eventId: number,
  itemId: string,
  type: string,
): TimelineEntry {
  const entry: TimelineEntry = {
    id: `event-${eventId}-item-${itemId}`,
    at,
    kind: "item",
    runId,
    item: { id: itemId, type, status: "inProgress" },
  };
  entries.push(entry);
  return entry;
}

function inferItemTypeFromDeltaMethod(method: string): string {
  switch (method) {
    case "item/agentMessage/delta":
      return "agentMessage";
    case "item/plan/delta":
      return "plan";
    case "item/reasoning/summaryTextDelta":
      return "reasoning";
    default:
      return "unknown";
  }
}

function materializeNotificationItem(raw: unknown): TimelineItemPayload | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const itemObj = raw as Record<string, unknown>;
  const id = typeof itemObj.id === "string" ? itemObj.id : undefined;
  const type = typeof itemObj.type === "string" ? itemObj.type : "unknown";
  if (!id) return undefined;

  const item: TimelineItemPayload = {
    id,
    type,
    status: typeof itemObj.status === "string" ? itemObj.status : "inProgress",
  };

  if ((type === "agentMessage" || type === "userMessage" || type === "plan") && typeof itemObj.text === "string") {
    item.text = itemObj.text;
  }
  if (type === "reasoning") {
    if (Array.isArray(itemObj.summary)) {
      item.text = (itemObj.summary as string[]).join("\n");
    } else if (typeof itemObj.text === "string") {
      item.text = itemObj.text;
    }
  }
  if (type === "commandExecution") {
    const cmd = itemObj.command;
    item.command = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : undefined;
    if (typeof itemObj.aggregatedOutput === "string") item.output = itemObj.aggregatedOutput;
  }
  if (type === "fileChange" && Array.isArray(itemObj.changes)) {
    item.changes = itemObj.changes as unknown[];
  }
  if (type === "mcpToolCall") {
    item.toolName = `${String(itemObj.server ?? "")}/${String(itemObj.tool ?? "")}`;
  }
  if (type === "dynamicToolCall" && typeof itemObj.tool === "string") {
    item.toolName = itemObj.tool;
  }
  if (typeof itemObj.exitCode === "number") item.exitCode = itemObj.exitCode;
  if (typeof itemObj.durationMs === "number") item.durationMs = itemObj.durationMs;

  return item;
}

function mergeDefinedItemFields(base: TimelineItemPayload, patch: TimelineItemPayload): TimelineItemPayload {
  return {
    ...base,
    id: patch.id,
    type: patch.type,
    status: patch.status,
    ...(patch.text !== undefined ? { text: patch.text } : {}),
    ...(patch.command !== undefined ? { command: patch.command } : {}),
    ...(patch.output !== undefined ? { output: patch.output } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
    ...(patch.changes !== undefined ? { changes: patch.changes } : {}),
    ...(patch.toolName !== undefined ? { toolName: patch.toolName } : {}),
  };
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
