import { z } from "zod";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";
import { runContextSchema, type RunContext } from "./run-context.ts";
import { assertNever } from "./utils.ts";

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

// ─── Typed session-event payloads (plan §D2) ──────────────────────────
//
// Each eventType gets a typed payload; `parseIssueSessionEvent` is the parse
// boundary over the stringly DB storage (event_json stays JSON text). The
// same doctrine as D1 applies: malformed payloads fail loudly at parse, and
// boundary callers that iterate possibly-old DB rows degrade gracefully via
// `parseIssueSessionEventOrWarn`. All payload schemas are loose objects:
// legacy rows carry fields newer code no longer writes, and wake payloads are
// merged wholesale into the run context (which tolerates unknown keys too).

/** Human input payload for direct_reply / followup_prompt / followup_comment
 * / operator_prompt. Produced by agent-input-service.ts,
 * github-pr-comment-handler.ts and webhooks/agent-session-handler.ts;
 * consumed by deriveSessionWakePlan (followUps + replacement-PR facts). */
const inputMessagePayloadSchema = z.looseObject({
  text: z.string().optional(),
  body: z.string().optional(),
  author: z.string().optional(),
  source: z.string().optional(),
  operatorSource: z.string().optional(),
  replacementPrRequired: z.boolean().optional(),
  previousPrNumber: z.number().optional(),
  previousPrUrl: z.string().optional(),
  previousPrState: z.string().optional(),
  previousPrHeadSha: z.string().optional(),
});
export type InputMessageEventPayload = z.infer<typeof inputMessagePayloadSchema>;

/** Produced by agent-input-service.ts after steering a running turn;
 * consumed by run-finalizer.ts summarizePromptDeliveryEvents. */
const promptDeliveredPayloadSchema = z.looseObject({
  source: z.string().optional(),
  runId: z.number().optional(),
  runType: z.string().optional(),
  status: z.enum(["delivered", "delivery_failed"]).optional(),
  body: z.string().optional(),
  primitive: z.string().optional(),
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  error: z.string().optional(),
});
export type PromptDeliveredEventPayload = z.infer<typeof promptDeliveredPayloadSchema>;

/** Produced by agent-input-service.ts / service-issue-actions.ts /
 * webhooks/agent-session-handler.ts; consumed by status-note.ts. */
const stopRequestedPayloadSchema = z.looseObject({
  body: z.string().optional(),
  source: z.string().optional(),
  author: z.string().optional(),
  // Dirty-worktree facts from git-worktree-status.ts dirtyWorktreeEventPayload.
  summary: z.string().optional(),
  dirtyWorktree: z.boolean().optional(),
  mergeInProgress: z.boolean().optional(),
  unmergedPaths: z.array(z.string()).optional(),
  changedPaths: z.array(z.string()).optional(),
});
export type StopRequestedEventPayload = z.infer<typeof stopRequestedPayloadSchema>;

/** Produced by webhooks/desired-stage-recorder.ts; consumed by status-note.ts. */
const undelegatedPayloadSchema = z.looseObject({
  // Dirty-worktree facts from git-worktree-status.ts dirtyWorktreeEventPayload.
  summary: z.string().optional(),
  dirtyWorktree: z.boolean().optional(),
  mergeInProgress: z.boolean().optional(),
  unmergedPaths: z.array(z.string()).optional(),
  changedPaths: z.array(z.string()).optional(),
});
export type UndelegatedEventPayload = z.infer<typeof undelegatedPayloadSchema>;

/** Produced by service-issue-actions.ts / cli/data.ts when an operator
 * force-closes an issue. */
const operatorClosedPayloadSchema = z.looseObject({
  terminalState: z.enum(["done", "failed"]).optional(),
  reason: z.string().optional(),
});
export type OperatorClosedEventPayload = z.infer<typeof operatorClosedPayloadSchema>;

/** Audit payloads (delegation-audit.ts) and marker events carry free-form
 * diagnostic objects; nothing branches on their fields. */
const freeFormPayloadSchema = z.looseObject({});
export type FreeFormEventPayload = z.infer<typeof freeFormPayloadSchema>;

/**
 * The discriminated union over session events. Wake-carrying events
 * (delegated, child_*, completion_check_continue, review_changes_requested,
 * settled_red_ci, merge_steward_incident) use the RunContext schema because
 * deriveSessionWakePlan merges their payloads wholesale into the wake's run
 * context.
 */
export type TypedIssueSessionEvent =
  | { eventType: "delegated"; payload: RunContext | undefined }
  | { eventType: "delegation_observed"; payload: FreeFormEventPayload | undefined }
  | { eventType: "child_changed"; payload: RunContext | undefined }
  | { eventType: "child_delivered"; payload: RunContext | undefined }
  | { eventType: "child_regressed"; payload: RunContext | undefined }
  | { eventType: "direct_reply"; payload: InputMessageEventPayload | undefined }
  | { eventType: "completion_check_continue"; payload: RunContext | undefined }
  | { eventType: "followup_prompt"; payload: InputMessageEventPayload | undefined }
  | { eventType: "followup_comment"; payload: InputMessageEventPayload | undefined }
  | { eventType: "prompt_delivered"; payload: PromptDeliveredEventPayload | undefined }
  | { eventType: "self_comment"; payload: FreeFormEventPayload | undefined }
  | { eventType: "operator_prompt"; payload: InputMessageEventPayload | undefined }
  | { eventType: "review_changes_requested"; payload: RunContext | undefined }
  | { eventType: "settled_red_ci"; payload: RunContext | undefined }
  | { eventType: "merge_steward_incident"; payload: RunContext | undefined }
  | { eventType: "stop_requested"; payload: StopRequestedEventPayload | undefined }
  | { eventType: "operator_closed"; payload: OperatorClosedEventPayload | undefined }
  | { eventType: "undelegated"; payload: UndelegatedEventPayload | undefined }
  | { eventType: "issue_removed"; payload: FreeFormEventPayload | undefined }
  | { eventType: "pr_closed"; payload: FreeFormEventPayload | undefined }
  | { eventType: "pr_merged"; payload: FreeFormEventPayload | undefined }
  | { eventType: "run_released_authority"; payload: FreeFormEventPayload | undefined };

export class IssueSessionEventPayloadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IssueSessionEventPayloadError";
  }
}

function parsePayloadJson(event: Pick<IssueSessionEventRecord, "eventType" | "eventJson">): unknown {
  if (!event.eventJson) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.eventJson);
  } catch (error) {
    throw new IssueSessionEventPayloadError(
      `Malformed ${event.eventType} session-event payload JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IssueSessionEventPayloadError(
      `Malformed ${event.eventType} session-event payload: expected a JSON object, got ${Array.isArray(parsed) ? "array" : typeof parsed}`,
    );
  }
  return parsed;
}

function parseWithSchema<T>(
  event: Pick<IssueSessionEventRecord, "eventType" | "eventJson">,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false; error: z.ZodError } },
): T | undefined {
  const raw = parsePayloadJson(event);
  if (raw === undefined) return undefined;
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new IssueSessionEventPayloadError(
      `Invalid ${event.eventType} session-event payload: ${result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
      { cause: result.error },
    );
  }
  return result.data;
}

/**
 * Parse boundary for session events: returns the typed union member for the
 * event. FAILS LOUDLY (IssueSessionEventPayloadError) on malformed JSON or
 * schema violations — boundary callers over possibly-old DB rows should use
 * `parseIssueSessionEventOrWarn` instead.
 */
export function parseIssueSessionEvent(
  event: Pick<IssueSessionEventRecord, "eventType" | "eventJson">,
): TypedIssueSessionEvent {
  const eventType = event.eventType;
  switch (eventType) {
    case "delegated":
    case "child_changed":
    case "child_delivered":
    case "child_regressed":
    case "completion_check_continue":
    case "review_changes_requested":
    case "settled_red_ci":
    case "merge_steward_incident":
      return { eventType, payload: parseWithSchema(event, runContextSchema) as RunContext | undefined };
    case "direct_reply":
    case "followup_prompt":
    case "followup_comment":
    case "operator_prompt":
      return { eventType, payload: parseWithSchema(event, inputMessagePayloadSchema) };
    case "prompt_delivered":
      return { eventType, payload: parseWithSchema(event, promptDeliveredPayloadSchema) };
    case "stop_requested":
      return { eventType, payload: parseWithSchema(event, stopRequestedPayloadSchema) };
    case "operator_closed":
      return { eventType, payload: parseWithSchema(event, operatorClosedPayloadSchema) };
    case "undelegated":
      return { eventType, payload: parseWithSchema(event, undelegatedPayloadSchema) };
    case "delegation_observed":
    case "self_comment":
    case "issue_removed":
    case "pr_closed":
    case "pr_merged":
    case "run_released_authority":
      return { eventType, payload: parseWithSchema(event, freeFormPayloadSchema) };
    default:
      // Also reached at runtime for event_type values written by versions
      // that no longer exist in the union; the OrWarn boundary degrades them.
      return assertNever(eventType, "Unknown issue session event type");
  }
}

/**
 * Boundary variant: parse loudly, but degrade a bad payload to `undefined`
 * (and an unknown stored event type to `undefined` entirely) after reporting
 * through `warn`. The parse itself never silently coerces.
 */
export function parseIssueSessionEventOrWarn(
  event: Pick<IssueSessionEventRecord, "eventType" | "eventJson">,
  warn?: (message: string) => void,
): TypedIssueSessionEvent | undefined {
  try {
    return parseIssueSessionEvent(event);
  } catch (error) {
    warn?.(error instanceof Error ? error.message : String(error));
    if (error instanceof IssueSessionEventPayloadError) {
      // The event type itself is known — keep the event, drop the payload.
      return { eventType: event.eventType, payload: undefined } as TypedIssueSessionEvent;
    }
    return undefined;
  }
}

export interface SessionWakePlan {
  eventIds: number[];
  runType?: RunType | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  context: RunContext;
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
  onPayloadError?: (event: IssueSessionEventRecord, message: string) => void,
): SessionWakePlan | undefined {
  const actionableEvents = events.filter((event) => !NON_ACTIONABLE_SESSION_EVENTS.has(event.eventType));
  if (actionableEvents.length === 0) return undefined;
  if (actionableEvents.some((event) => TERMINAL_SESSION_EVENTS.has(event.eventType))) {
    return undefined;
  }

  const context: RunContext = {};
  const followUps: Array<{ type: string; text: string; author?: string }> = [];
  let eventIds: number[] = [];
  let wakeReason: string | undefined;
  let runType: RunType | undefined;
  let resumeThread = false;

  for (const event of actionableEvents) {
    // Boundary over DB rows: a payload written by an older version that no
    // longer matches the schema degrades to "no payload" instead of wedging
    // wake derivation for the whole issue.
    const typed = parseIssueSessionEventOrWarn(
      event,
      onPayloadError ? (message) => onPayloadError(event, message) : undefined,
    );
    if (!typed) continue;
    switch (typed.eventType) {
      case "merge_steward_incident":
        runType = "queue_repair";
        wakeReason = "merge_steward_incident";
        eventIds = [event.id];
        Object.assign(context, typed.payload ?? {});
        break;
      case "settled_red_ci":
        if (runType !== "queue_repair") {
          runType = "ci_repair";
          wakeReason = "settled_red_ci";
          eventIds = [event.id];
          Object.assign(context, typed.payload ?? {});
        }
        break;
      case "review_changes_requested":
        if (isStaleRequestedChangesEvent(issue, typed.payload)) {
          break;
        }
        if (runType !== "queue_repair" && runType !== "ci_repair") {
          runType = typed.payload?.branchUpkeepRequired === true ? "branch_upkeep" : "review_fix";
          wakeReason = typed.payload?.branchUpkeepRequired === true ? "branch_upkeep" : "review_changes_requested";
          eventIds = [event.id];
          Object.assign(context, typed.payload ?? {});
        }
        break;
      case "delegated":
        if (!runType) {
          runType = parseRunType(typed.payload?.runType) ?? "implementation";
          wakeReason = issue.issueClass === "orchestration" ? "initial_delegate" : "delegated";
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        Object.assign(context, typed.payload ?? {});
        break;
      case "child_changed":
      case "child_delivered":
      case "child_regressed":
        if (!runType) {
          runType = "implementation";
          wakeReason = typed.eventType;
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        Object.assign(context, typed.payload ?? {});
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
        const text = typed.payload?.text ?? typed.payload?.body;
        if (text) {
          followUps.push({
            type: typed.eventType,
            text,
            ...(typed.payload?.author !== undefined ? { author: typed.payload.author } : {}),
          });
        }
        context.directReplyMode = true;
        resumeThread = true;
        break;
      }
      case "completion_check_continue": {
        if (!runType) {
          runType = parseRunType(typed.payload?.runType)
            ?? (issue.prReviewState === "changes_requested" ? "review_fix" : "implementation");
          wakeReason = "completion_check_continue";
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        Object.assign(context, typed.payload ?? {});
        if (typed.payload?.summary?.trim()) {
          context.completionCheckSummary = typed.payload.summary.trim();
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
          wakeReason = issue.issueClass === "orchestration" ? "human_instruction" : typed.eventType;
          eventIds = [event.id];
        } else {
          eventIds.push(event.id);
        }
        const text = typed.payload?.text ?? typed.payload?.body;
        if (text) {
          followUps.push({
            type: typed.eventType,
            text,
            ...(typed.payload?.author !== undefined ? { author: typed.payload.author } : {}),
          });
        }
        if (typed.payload?.replacementPrRequired === true) {
          context.replacementPrRequired = true;
          if (typed.payload.previousPrNumber !== undefined) context.previousPrNumber = typed.payload.previousPrNumber;
          if (typed.payload.previousPrUrl !== undefined) context.previousPrUrl = typed.payload.previousPrUrl;
          if (typed.payload.previousPrState !== undefined) context.previousPrState = typed.payload.previousPrState;
          if (typed.payload.previousPrHeadSha !== undefined) context.previousPrHeadSha = typed.payload.previousPrHeadSha;
        }
        resumeThread = true;
        break;
      }
      // Terminal and non-actionable events were filtered out above; listed
      // here so the switch stays exhaustive over the union.
      case "delegation_observed":
      case "prompt_delivered":
      case "self_comment":
      case "run_released_authority":
      case "stop_requested":
      case "operator_closed":
      case "undelegated":
      case "issue_removed":
      case "pr_closed":
      case "pr_merged":
        break;
      default:
        assertNever(typed, "Unhandled issue session event in wake derivation");
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

function isStaleRequestedChangesEvent(
  issue: Pick<IssueRecord, "prHeadSha">,
  payload: RunContext | undefined,
): boolean {
  if (payload?.branchUpkeepRequired === true) return false;
  const requestedChangesHeadSha = payload?.requestedChangesHeadSha;
  if (!requestedChangesHeadSha || !issue.prHeadSha) return false;
  return requestedChangesHeadSha !== issue.prHeadSha;
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
        outcomeSummary?: unknown;
        publicationRecapSummary?: unknown;
        latestAssistantMessage?: unknown;
      };
      if (typeof parsed.outcomeSummary === "string" && parsed.outcomeSummary.trim()) {
        return sanitizeOperatorFacingText(parsed.outcomeSummary);
      }
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
