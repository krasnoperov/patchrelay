import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";

export type IssueSessionEventType =
  | "delegated"
  | "followup_prompt"
  | "followup_comment"
  | "self_comment"
  | "operator_prompt"
  | "review_changes_requested"
  | "settled_red_ci"
  | "merge_steward_incident"
  | "stop_requested"
  | "undelegated"
  | "issue_removed"
  | "pr_closed"
  | "pr_merged";

export interface IssueSessionEventRecord {
  id: number;
  projectId: string;
  linearIssueId: string;
  eventType: IssueSessionEventType;
  eventJson?: string | undefined;
  dedupeKey?: string | undefined;
  createdAt: string;
  processedAt?: string | undefined;
  consumedByRunId?: number | undefined;
}

export interface SessionWakePlan {
  runType?: RunType | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  context: Record<string, unknown>;
}

const TERMINAL_SESSION_EVENTS = new Set<IssueSessionEventType>([
  "stop_requested",
  "undelegated",
  "issue_removed",
  "pr_closed",
  "pr_merged",
]);

export function deriveSessionWakePlan(
  issue: IssueRecord,
  events: IssueSessionEventRecord[],
): SessionWakePlan | undefined {
  if (events.length === 0) return undefined;
  if (events.some((event) => TERMINAL_SESSION_EVENTS.has(event.eventType))) {
    return undefined;
  }

  const context: Record<string, unknown> = {};
  const followUps: Array<{ type: string; text: string; author?: string }> = [];
  let wakeReason: string | undefined;
  let runType: RunType | undefined;
  let resumeThread = false;

  for (const event of events) {
    const payload = parseEventJson(event.eventJson);
    switch (event.eventType) {
      case "merge_steward_incident":
        runType = "queue_repair";
        wakeReason = "merge_steward_incident";
        Object.assign(context, payload ?? {});
        break;
      case "settled_red_ci":
        if (runType !== "queue_repair") {
          runType = "ci_repair";
          wakeReason = "settled_red_ci";
          Object.assign(context, payload ?? {});
        }
        break;
      case "review_changes_requested":
        if (runType !== "queue_repair" && runType !== "ci_repair") {
          runType = "review_fix";
          wakeReason = "review_changes_requested";
          Object.assign(context, payload ?? {});
        }
        break;
      case "delegated":
        if (!runType) {
          runType = "implementation";
          wakeReason = "delegated";
        }
        if (payload?.promptContext !== undefined) {
          context.promptContext = payload.promptContext;
        }
        if (payload?.promptBody !== undefined) {
          context.promptBody = payload.promptBody;
        }
        break;
      case "followup_prompt":
      case "followup_comment":
      case "operator_prompt": {
        if (!runType) {
          runType = issue.prReviewState === "changes_requested" ? "review_fix" : "implementation";
          wakeReason = event.eventType;
        }
        const text = typeof payload?.text === "string"
          ? payload.text
          : typeof payload?.body === "string" ? payload.body : undefined;
        if (text) {
          followUps.push({
            type: event.eventType,
            text,
            ...(typeof payload?.author === "string" ? { author: payload.author } : {}),
          });
        }
        if (
          event.eventType === "followup_prompt"
          || event.eventType === "followup_comment"
          || event.eventType === "operator_prompt"
        ) {
          resumeThread = true;
        }
        break;
      }
      default:
        break;
    }
  }

  if (!runType) return undefined;
  if (followUps.length > 0) {
    context.followUps = followUps;
    context.followUpMode = true;
    context.followUpCount = followUps.length;
  }
  if (wakeReason) {
    context.wakeReason = wakeReason;
  }

  return { runType, wakeReason, resumeThread, context };
}

export function extractLatestAssistantSummary(run: RunRecord | undefined): string | undefined {
  if (!run) return undefined;
  if (run.summaryJson) {
    try {
      const parsed = JSON.parse(run.summaryJson) as { latestAssistantMessage?: unknown };
      if (typeof parsed.latestAssistantMessage === "string" && parsed.latestAssistantMessage.trim()) {
        return parsed.latestAssistantMessage;
      }
    } catch {
      // ignore malformed summary json
    }
  }
  if (run.reportJson) {
    try {
      const parsed = JSON.parse(run.reportJson) as { assistantMessages?: unknown };
      if (Array.isArray(parsed.assistantMessages)) {
        const latest = parsed.assistantMessages.findLast((value) => typeof value === "string" && value.trim());
        if (typeof latest === "string") return latest;
      }
    } catch {
      // ignore malformed report json
    }
  }
  return run.failureReason;
}

function parseEventJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}
