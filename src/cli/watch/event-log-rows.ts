import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { TimelineRunInput } from "./timeline-builder.ts";
import { relativeTime, truncate } from "./format-utils.ts";
export { relativeTime };

export type EventCategory = "stage" | "run" | "github" | "review" | "human";

export interface EventLogLine {
  id: string;
  at: string;
  category: EventCategory;
  phrase: string;
  color?: string | undefined;
  continuation?: string | undefined;
}

interface EventSource {
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
}

const RUN_LABEL: Record<string, string> = {
  implementation: "implementation",
  main_repair: "main repair",
  ci_repair: "ci repair",
  review_fix: "review fix",
  branch_upkeep: "branch upkeep",
  queue_repair: "queue repair",
};

export function buildEventLogLines(source: EventSource): EventLogLine[] {
  const lines: EventLogLine[] = [];

  for (const run of source.rawRuns) {
    const label = RUN_LABEL[run.runType] ?? run.runType;
    lines.push({
      id: `run-start-${run.id}`,
      at: run.startedAt,
      category: "run",
      phrase: `${label} started`,
    });
    if (run.endedAt) {
      const failed = run.status === "failed" || run.status === "errored";
      const reason = run.report && typeof run.report === "object"
        ? extractFailureReason(run.report as unknown as Record<string, unknown>)
        : undefined;
      lines.push({
        id: `run-end-${run.id}`,
        at: run.endedAt,
        category: "run",
        phrase: `${label} ended · ${humanStatus(run.status)}`,
        color: failed ? "red" : run.status === "completed" ? "green" : undefined,
        ...(failed && reason ? { continuation: reason } : {}),
      });
    }
  }

  for (const event of source.rawFeedEvents) {
    const mapped = mapFeedEvent(event);
    if (mapped) lines.push(mapped);
  }

  lines.sort((left, right) => {
    const lt = new Date(left.at).getTime();
    const rt = new Date(right.at).getTime();
    if (lt !== rt) return lt - rt;
    return left.id.localeCompare(right.id);
  });

  return lines;
}

function mapFeedEvent(event: OperatorFeedEvent): EventLogLine | null {
  const base: Pick<EventLogLine, "id" | "at"> = { id: `feed-${event.id}`, at: event.at };
  switch (event.kind) {
    case "stage": {
      const phrase = formatStagePhrase(event);
      if (!phrase) return null;
      return {
        ...base,
        category: "stage",
        phrase,
        ...(event.level === "error" ? { color: "red" } : event.level === "warn" ? { color: "yellow" } : {}),
      };
    }
    case "github":
      return { ...base, category: "github", phrase: compactSummary(event), ...(event.level === "error" ? { color: "red" } : {}) };
    case "linear":
      return { ...base, category: "github", phrase: compactSummary(event) };
    case "comment":
      return { ...base, category: "review", phrase: compactSummary(event) };
    case "agent":
    case "turn": {
      const summary = event.summary?.toLowerCase() ?? "";
      if (summary.startsWith("prompt")) {
        return { ...base, category: "human", phrase: compactSummary(event) };
      }
      return null;
    }
    default:
      return null;
  }
}

function formatStagePhrase(event: OperatorFeedEvent): string | null {
  const from = event.stage;
  const to = event.nextStage;
  if (from && to) return `${from} → ${to}`;
  if (event.summary) return compactSummary(event);
  return null;
}

function compactSummary(event: OperatorFeedEvent): string {
  const summary = event.summary?.trim() ?? "";
  if (!summary) return event.kind;
  return summary;
}

function extractFailureReason(report: Record<string, unknown>): string | undefined {
  const reason = report["failureReason"] ?? report["error"] ?? report["message"];
  if (typeof reason === "string" && reason.trim().length > 0) {
    return truncate(reason.replace(/\s+/g, " ").trim(), 140);
  }
  return undefined;
}

function humanStatus(status: string): string {
  switch (status) {
    case "completed":
    case "succeeded":
      return "success";
    case "failed":
    case "errored":
      return "failed";
    case "running":
      return "running";
    default:
      return status;
  }
}

export function formatEventAge(at: string): string {
  return relativeTime(at);
}
