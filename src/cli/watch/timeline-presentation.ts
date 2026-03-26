import type {
  TimelineCIChecksPayload,
  TimelineEntry,
  TimelineFeedPayload,
  TimelineItemPayload,
  TimelineRunPayload,
} from "./timeline-builder.ts";

export type TimelineMode = "compact" | "verbose";

export type TimelineDisplayRow =
  | {
      id: string;
      kind: "run";
      at: string;
      finalized: boolean;
      run: TimelineRunPayload;
      details: TimelineRunDetail[];
    }
  | {
      id: string;
      kind: "feed";
      at: string;
      finalized: true;
      feed: TimelineFeedPayload;
    }
  | {
      id: string;
      kind: "ci-checks";
      at: string;
      finalized: true;
      ciChecks: TimelineCIChecksPayload;
    }
  | {
      id: string;
      kind: "item";
      at: string;
      finalized: boolean;
      item: TimelineItemPayload;
    };

export interface TimelineRunDetail {
  tone: "message" | "command" | "meta" | "user";
  text: string;
}

interface CompactRunAccumulator {
  id: string;
  at: string;
  run: TimelineRunPayload;
  items: TimelineItemPayload[];
  endedAt?: string | undefined;
}

export function buildTimelineRows(entries: TimelineEntry[], mode: TimelineMode): TimelineDisplayRow[] {
  return mode === "compact" ? buildCompactTimelineRows(entries) : buildVerboseTimelineRows(entries);
}

function buildVerboseTimelineRows(entries: TimelineEntry[]): TimelineDisplayRow[] {
  return entries.flatMap<TimelineDisplayRow>((entry) => {
    switch (entry.kind) {
      case "run-start":
        return [{
          id: entry.id,
          kind: "run",
          at: entry.at,
          finalized: false,
          run: entry.run!,
          details: [],
        }];
      case "run-end":
        return [{
          id: entry.id,
          kind: "run",
          at: entry.at,
          finalized: true,
          run: entry.run!,
          details: [],
        }];
      case "feed":
        return [{
          id: entry.id,
          kind: "feed",
          at: entry.at,
          finalized: true,
          feed: entry.feed!,
        }];
      case "ci-checks":
        return [{
          id: entry.id,
          kind: "ci-checks",
          at: entry.at,
          finalized: true,
          ciChecks: entry.ciChecks!,
        }];
      case "item":
        return [{
          id: entry.id,
          kind: "item",
          at: entry.at,
          finalized: entry.item?.status !== "inProgress",
          item: entry.item!,
        }];
    }
  });
}

function buildCompactTimelineRows(entries: TimelineEntry[]): TimelineDisplayRow[] {
  const rows: TimelineDisplayRow[] = [];
  const runs = new Map<number, CompactRunAccumulator>();

  for (const entry of entries) {
    if (entry.kind === "run-start" && entry.runId !== undefined) {
      const existing = runs.get(entry.runId);
      if (!existing) {
        const run = { ...entry.run! };
        runs.set(entry.runId, {
          id: `run-${entry.runId}`,
          at: run.startedAt,
          run,
          items: [],
          endedAt: run.endedAt,
        });
      }
      continue;
    }

    if (entry.kind === "run-end" && entry.runId !== undefined) {
      const existing = runs.get(entry.runId);
      if (existing) {
        existing.run = { ...entry.run! };
        existing.endedAt = entry.run?.endedAt;
      } else {
        const run = { ...entry.run! };
        runs.set(entry.runId, {
          id: `run-${entry.runId}`,
          at: run.startedAt,
          run,
          items: [],
          endedAt: run.endedAt,
        });
      }
      continue;
    }

    if (entry.kind === "item" && entry.runId !== undefined && runs.has(entry.runId)) {
      runs.get(entry.runId)!.items.push(entry.item!);
      continue;
    }

    if (entry.kind === "feed" && shouldHideFeedInCompact(entry.feed!)) {
      continue;
    }

    if (entry.kind === "feed") {
      rows.push({
        id: entry.id,
        kind: "feed",
        at: entry.at,
        finalized: true,
        feed: entry.feed!,
      });
      continue;
    }

    if (entry.kind === "ci-checks") {
      rows.push({
        id: entry.id,
        kind: "ci-checks",
        at: entry.at,
        finalized: true,
        ciChecks: entry.ciChecks!,
      });
      continue;
    }

    if (entry.kind === "item") {
      rows.push({
        id: entry.id,
        kind: "item",
        at: entry.at,
        finalized: entry.item?.status !== "inProgress",
        item: entry.item!,
      });
    }
  }

  for (const run of runs.values()) {
    const status = resolveCompactRunStatus(run.run, run.items);
    rows.push({
      id: run.id,
      kind: "run",
      at: run.at,
      finalized: status !== "running",
      run: { ...run.run, status, ...(run.endedAt ? { endedAt: run.endedAt } : {}) },
      details: summarizeRunDetails(run.items, status),
    });
  }

  rows.sort((left, right) => {
    const cmp = left.at.localeCompare(right.at);
    if (cmp !== 0) return cmp;
    return rowKindOrder(left.kind) - rowKindOrder(right.kind);
  });

  return rows;
}

function shouldHideFeedInCompact(feed: TimelineFeedPayload): boolean {
  if (feed.feedKind === "stage" && feed.status === "starting") {
    return true;
  }
  if (feed.feedKind === "turn" && (feed.status === "completed" || feed.status === "failed")) {
    return true;
  }
  return false;
}

function resolveCompactRunStatus(run: TimelineRunPayload, items: TimelineItemPayload[]): string {
  if (run.endedAt || run.status === "completed" || run.status === "failed" || run.status === "released") {
    return run.status;
  }
  if (items.some((item) => item.status === "inProgress")) {
    return "running";
  }
  return run.status === "queued" ? "queued" : "running";
}

function summarizeRunDetails(items: TimelineItemPayload[], status: string): TimelineRunDetail[] {
  const details: TimelineRunDetail[] = [];

  const latestAgentMessage = findLatest(items, (item) => item.type === "agentMessage" && Boolean(item.text?.trim()));
  const latestUserMessage = findLatest(items, (item) => item.type === "userMessage" && Boolean(item.text?.trim()));
  const activeCommand = findLatest(items, (item) => item.type === "commandExecution" && item.status === "inProgress");
  const latestCommand = activeCommand ?? findLatest(items, (item) => item.type === "commandExecution" && Boolean(item.command?.trim()));
  const latestFileChange = findLatest(items, (item) => item.type === "fileChange" && Array.isArray(item.changes) && item.changes.length > 0);

  if (latestUserMessage && !latestAgentMessage) {
    details.push({
      tone: "user",
      text: `you: ${summarizeNarrative(latestUserMessage.text ?? "", 120)}`,
    });
  }

  if (latestAgentMessage) {
    details.push({
      tone: "message",
      text: summarizeNarrative(latestAgentMessage.text ?? "", status === "running" ? 140 : 180),
    });
  }

  if (latestCommand?.command) {
    details.push({
      tone: "command",
      text: cleanCommand(latestCommand.command),
    });
  }

  if (latestFileChange?.changes?.length) {
    details.push({
      tone: "meta",
      text: summarizeFileChanges(latestFileChange.changes),
    });
  } else {
    const tools = summarizeToolCalls(items);
    if (tools) {
      details.push({
        tone: "meta",
        text: tools,
      });
    }
  }

  return dedupeDetails(details).slice(0, 3);
}

function summarizeNarrative(input: string, max: number): string {
  const normalized = input
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";

  const sentence = normalized.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? normalized;
  return truncate(sentence, max);
}

function summarizeFileChanges(changes: unknown[]): string {
  const files = Array.from(new Set(
    changes
      .map((change) => {
        if (!change || typeof change !== "object") return undefined;
        const path = (change as Record<string, unknown>).path;
        return typeof path === "string" && path.trim() ? path : undefined;
      })
      .filter((path): path is string => Boolean(path)),
  ));

  if (files.length === 0) {
    return `updated ${changes.length} file${changes.length === 1 ? "" : "s"}`;
  }

  const names = files.map((path) => path.split("/").at(-1) ?? path);
  const preview = names.slice(0, 3).join(", ");
  const remainder = names.length > 3 ? ` +${names.length - 3}` : "";
  return `updated ${files.length} file${files.length === 1 ? "" : "s"}: ${preview}${remainder}`;
}

function summarizeToolCalls(items: TimelineItemPayload[]): string | undefined {
  const names = Array.from(new Set(
    items
      .filter((item) => item.type === "mcpToolCall" || item.type === "dynamicToolCall")
      .map((item) => item.toolName)
      .filter((name): name is string => Boolean(name)),
  ));

  if (names.length === 0) return undefined;
  const preview = names.slice(0, 2).join(", ");
  const remainder = names.length > 2 ? ` +${names.length - 2}` : "";
  return `used ${names.length} tool${names.length === 1 ? "" : "s"}: ${preview}${remainder}`;
}

function dedupeDetails(details: TimelineRunDetail[]): TimelineRunDetail[] {
  const seen = new Set<string>();
  return details.filter((detail) => {
    const key = `${detail.tone}:${detail.text.toLowerCase()}`;
    if (!detail.text.trim() || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findLatest(
  items: TimelineItemPayload[],
  predicate: (item: TimelineItemPayload) => boolean,
): TimelineItemPayload | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (predicate(item)) {
      return item;
    }
  }
  return undefined;
}

function rowKindOrder(kind: TimelineDisplayRow["kind"]): number {
  switch (kind) {
    case "run":
      return 0;
    case "feed":
      return 1;
    case "ci-checks":
      return 2;
    case "item":
      return 3;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function cleanCommand(raw: string): string {
  const bashMatch = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+['"](.+?)['"]$/s);
  if (bashMatch?.[1]) return truncate(bashMatch[1], 120);
  const bashMatch2 = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+"(.+?)"$/s);
  if (bashMatch2?.[1]) return truncate(bashMatch2[1], 120);
  return truncate(raw, 120);
}
