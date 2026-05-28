import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";

export type IssueSessionEventType =
  | "delegated"
  | "delegation_observed"
  | "child_changed"
  | "child_delivered"
  | "child_regressed"
  | "direct_reply"
  | "completion_check_continue"
  | "followup_prompt"
  | "followup_comment"
  | "prompt_delivered"
  | "self_comment"
  | "operator_prompt"
  | "review_changes_requested"
  | "settled_red_ci"
  | "merge_steward_incident"
  | "stop_requested"
  | "operator_closed"
  | "undelegated"
  | "issue_removed"
  | "pr_closed"
  | "pr_merged"
  | "run_released_authority";

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
  eventIds: number[];
  runType?: RunType | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  context: Record<string, unknown>;
}

const TERMINAL_SESSION_EVENTS = new Set<IssueSessionEventType>([
  "stop_requested",
  "operator_closed",
  "undelegated",
  "issue_removed",
  "pr_closed",
  "pr_merged",
]);

const NON_ACTIONABLE_SESSION_EVENTS = new Set<IssueSessionEventType>([
  "delegation_observed",
  "prompt_delivered",
  "self_comment",
  "run_released_authority",
]);

// "main_repair" was removed as a run type; legacy session-event payloads carrying it
// are not in this set, so parseRunType returns undefined and callers fall back to
// "implementation" (see deriveSessionWakePlan below).
const RUN_TYPES = new Set<RunType>(["implementation", "review_fix", "branch_upkeep", "ci_repair", "queue_repair"]);

function parseRunType(value: unknown): RunType | undefined {
  return typeof value === "string" && RUN_TYPES.has(value as RunType) ? value as RunType : undefined;
}

export function deriveSessionWakePlan(
  issue: IssueRecord,
  events: IssueSessionEventRecord[],
): SessionWakePlan | undefined {
  const actionableEvents = events.filter((event) => !NON_ACTIONABLE_SESSION_EVENTS.has(event.eventType));
  if (actionableEvents.length === 0) return undefined;
  if (actionableEvents.some((event) => TERMINAL_SESSION_EVENTS.has(event.eventType))) {
    return undefined;
  }

  const context: Record<string, unknown> = {};
  const followUps: Array<{ type: string; text: string; author?: string }> = [];
  let eventIds: number[] = [];
  let wakeReason: string | undefined;
  let runType: RunType | undefined;
  let resumeThread = false;

  for (const event of actionableEvents) {
    const payload = parseEventJson(event.eventJson);
    switch (event.eventType) {
      case "merge_steward_incident":
        runType = "queue_repair";
        wakeReason = "merge_steward_incident";
        eventIds = [event.id];
        Object.assign(context, payload ?? {});
        break;
      case "settled_red_ci":
        if (runType !== "queue_repair") {
          runType = "ci_repair";
          wakeReason = "settled_red_ci";
          eventIds = [event.id];
          Object.assign(context, payload ?? {});
        }
        break;
      case "review_changes_requested":
        if (runType !== "queue_repair" && runType !== "ci_repair") {
          runType = payload?.branchUpkeepRequired === true ? "branch_upkeep" : "review_fix";
          wakeReason = payload?.branchUpkeepRequired === true ? "branch_upkeep" : "review_changes_requested";
          eventIds = [event.id];
          Object.assign(context, payload ?? {});
        }
        break;
      case "delegated":
        if (!runType) {
          runType = parseRunType(payload?.runType) ?? "implementation";
          wakeReason = issue.issueClass === "orchestration" ? "initial_delegate" : "delegated";
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        Object.assign(context, payload ?? {});
        break;
      case "child_changed":
      case "child_delivered":
      case "child_regressed":
        if (!runType) {
          runType = "implementation";
          wakeReason = event.eventType;
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        Object.assign(context, payload ?? {});
        resumeThread = true;
        break;
      case "direct_reply": {
        if (!runType) {
          runType = issue.prReviewState === "changes_requested" ? "review_fix" : "implementation";
          wakeReason = "direct_reply";
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
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
        context.directReplyMode = true;
        resumeThread = true;
        break;
      }
      case "completion_check_continue": {
        if (!runType) {
          runType = parseRunType(payload?.runType)
            ?? (issue.prReviewState === "changes_requested" ? "review_fix" : "implementation");
          wakeReason = "completion_check_continue";
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        if (typeof payload?.summary === "string" && payload.summary.trim()) {
          context.completionCheckSummary = payload.summary.trim();
        }
        context.completionCheckMode = true;
        resumeThread = true;
        break;
      }
      case "followup_prompt":
      case "followup_comment":
      case "operator_prompt": {
        if (!runType) {
          runType = issue.prReviewState === "changes_requested" ? "review_fix" : "implementation";
          wakeReason = issue.issueClass === "orchestration" ? "human_instruction" : event.eventType;
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
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
        if (payload?.replacementPrRequired === true) {
          context.replacementPrRequired = true;
          if (typeof payload.previousPrNumber === "number") context.previousPrNumber = payload.previousPrNumber;
          if (typeof payload.previousPrUrl === "string") context.previousPrUrl = payload.previousPrUrl;
          if (typeof payload.previousPrState === "string") context.previousPrState = payload.previousPrState;
          if (typeof payload.previousPrHeadSha === "string") context.previousPrHeadSha = payload.previousPrHeadSha;
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

  return { eventIds, runType, wakeReason, resumeThread, context };
}

export function isActionableIssueSessionEventType(eventType: IssueSessionEventType): boolean {
  return !NON_ACTIONABLE_SESSION_EVENTS.has(eventType);
}

export function extractLatestAssistantSummary(
  run: Pick<RunRecord, "summaryJson" | "reportJson" | "failureReason"> | undefined,
): string | undefined {
  if (!run) return undefined;
  if (run.summaryJson) {
    try {
      const parsed = JSON.parse(run.summaryJson) as {
        publicationRecapSummary?: unknown;
        latestAssistantMessage?: unknown;
      };
      if (typeof parsed.publicationRecapSummary === "string" && parsed.publicationRecapSummary.trim()) {
        return sanitizeOperatorFacingText(parsed.publicationRecapSummary);
      }
      if (typeof parsed.latestAssistantMessage === "string" && parsed.latestAssistantMessage.trim()) {
        return sanitizeOperatorFacingText(parsed.latestAssistantMessage);
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
        if (typeof latest === "string") return sanitizeOperatorFacingText(latest);
      }
    } catch {
      // ignore malformed report json
    }
  }
  return sanitizeOperatorFacingText(run.failureReason);
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
