import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type {
  TimelineEntry,
  TimelineRunInput,
} from "./timeline-builder.ts";
import {
  buildTimelineFromRehydration,
  appendFeedToTimeline,
  appendCodexItemToTimeline,
  completeCodexItemInTimeline,
  appendDeltaToTimelineItem,
} from "./timeline-builder.ts";
import type { CodexThreadSummary } from "../../types.ts";

// Re-export for consumers
export type { TimelineEntry, TimelineItemPayload, TimelineRunInput } from "./timeline-builder.ts";
export type { OperatorFeedEvent } from "../../operator-feed.ts";

// ─── Issue (list view) ────────────────────────────────────────────

export interface WatchIssue {
  issueKey?: string | undefined;
  title?: string | undefined;
  statusNote?: string | undefined;
  projectId: string;
  sessionState?: string | undefined;
  factoryState: string;
  blockedByCount: number;
  blockedByKeys: string[];
  readyForExecution: boolean;
  currentLinearState?: string | undefined;
  activeRunType?: string | undefined;
  pendingRunType?: string | undefined;
  latestRunType?: string | undefined;
  latestRunStatus?: string | undefined;
  prNumber?: number | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  prChecksSummary?: {
    total: number;
    completed: number;
    passed: number;
    failed: number;
    pending: number;
    overall: "pending" | "success" | "failure";
    failedNames?: string[] | undefined;
  } | undefined;
  latestFailureSource?: string | undefined;
  latestFailureHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
  latestFailureStepName?: string | undefined;
  latestFailureSummary?: string | undefined;
  waitingReason?: string | undefined;
  updatedAt: string;
}

// ─── Detail metadata (header, not timeline entries) ───────────────

export interface WatchTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface WatchDiffSummary {
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface WatchIssueContext {
  description?: string | undefined;
  currentLinearState?: string | undefined;
  issueUrl?: string | undefined;
  worktreePath?: string | undefined;
  branchName?: string | undefined;
  prUrl?: string | undefined;
  priority?: number | undefined;
  estimate?: number | undefined;
  ciRepairAttempts: number;
  queueRepairAttempts: number;
  reviewFixAttempts: number;
  latestFailureSource?: string | undefined;
  latestFailureHeadSha?: string | undefined;
  latestFailureCheckName?: string | undefined;
  latestFailureStepName?: string | undefined;
  latestFailureSummary?: string | undefined;
  runCount: number;
}

// ─── Top-level State ──────────────────────────────────────────────

export type WatchFilter = "all" | "active" | "non-done";

export type WatchView = "list" | "detail" | "feed";

export type DetailTab = "timeline" | "history";

export interface WatchState {
  connected: boolean;
  lastServerMessageAt: number | null;
  issues: WatchIssue[];
  selectedIndex: number;
  view: WatchView;
  activeDetailKey: string | null;
  filter: WatchFilter;
  follow: boolean;
  // Detail view state
  detailTab: DetailTab;
  timeline: TimelineEntry[];
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  activeRunId: number | null;
  activeRunStartedAt: string | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  // Feed view state
  feedEvents: OperatorFeedEvent[];
}

export type WatchAction =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "stream-heartbeat"; receivedAt: number }
  | { type: "issues-snapshot"; issues: WatchIssue[]; receivedAt: number }
  | { type: "feed-event"; event: OperatorFeedEvent; receivedAt: number }
  | { type: "select"; index: number }
  | { type: "enter-detail"; issueKey: string }
  | { type: "exit-detail" }
  | { type: "detail-navigate"; direction: "next" | "prev"; filtered: WatchIssue[] }
  | { type: "timeline-rehydrate"; runs: TimelineRunInput[]; feedEvents: OperatorFeedEvent[]; liveThread: CodexThreadSummary | null; activeRunId: number | null; activeRunStartedAt?: string | null; issueContext: WatchIssueContext | null }
  | { type: "codex-notification"; method: string; params: Record<string, unknown> }
  | { type: "cycle-filter" }
  | { type: "toggle-follow" }
  | { type: "enter-feed" }
  | { type: "exit-feed" }
  | { type: "feed-snapshot"; events: OperatorFeedEvent[] }
  | { type: "feed-new-event"; event: OperatorFeedEvent }
  | { type: "switch-detail-tab"; tab: DetailTab }
  | { type: "toggle-timeline-mode" };

// ─── Array size caps (prevent OOM) ───────────────────────────────

const MAX_TIMELINE_ENTRIES = 2000;
const MAX_RAW_FEED_EVENTS = 2000;
const MAX_FEED_EVENTS = 1000;

function capArray<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

const DETAIL_INITIAL = {
  detailTab: "timeline" as DetailTab,
  timeline: [] as TimelineEntry[],
  rawRuns: [] as TimelineRunInput[],
  rawFeedEvents: [] as OperatorFeedEvent[],
  activeRunId: null as number | null,
  activeRunStartedAt: null as string | null,
  tokenUsage: null as WatchTokenUsage | null,
  diffSummary: null as WatchDiffSummary | null,
  plan: null as Array<{ step: string; status: string }> | null,
  issueContext: null as WatchIssueContext | null,
};

export const initialWatchState: WatchState = {
  connected: false,
  lastServerMessageAt: null,
  issues: [],
  selectedIndex: 0,
  view: "list",
  activeDetailKey: null,
  filter: "non-done",
  follow: true,
  ...DETAIL_INITIAL,
  feedEvents: [],
};

const TERMINAL_FACTORY_STATES = new Set(["done", "failed"]);

export function filterIssues(issues: WatchIssue[], filter: WatchFilter): WatchIssue[] {
  switch (filter) {
    case "all":
      return issues;
    case "active":
      return issues.filter((i) => i.activeRunType !== undefined);
    case "non-done":
      return issues.filter((i) => !TERMINAL_FACTORY_STATES.has(i.factoryState));
  }
}

export interface IssueAggregates {
  active: number;
  blocked: number;
  ready: number;
  done: number;
  failed: number;
  total: number;
}

const DONE_STATES = new Set(["done"]);
const FAILED_STATES = new Set(["failed", "escalated"]);

export function computeAggregates(issues: WatchIssue[]): IssueAggregates {
  let active = 0;
  let blocked = 0;
  let ready = 0;
  let done = 0;
  let failed = 0;
  for (const issue of issues) {
    if (issue.activeRunType) active++;
    if (!issue.activeRunType && issue.blockedByCount > 0) blocked++;
    if (!issue.activeRunType && issue.readyForExecution) ready++;
    if (DONE_STATES.has(issue.factoryState)) done++;
    if (FAILED_STATES.has(issue.factoryState)) failed++;
  }
  return { active, blocked, ready, done, failed, total: issues.length };
}

function nextFilter(filter: WatchFilter): WatchFilter {
  switch (filter) {
    case "non-done": return "active";
    case "active": return "all";
    case "all": return "non-done";
  }
}

// ─── Reducer ──────────────────────────────────────────────────────

export function watchReducer(state: WatchState, action: WatchAction): WatchState {
  switch (action.type) {
    case "connected":
      return { ...state, connected: true };

    case "disconnected":
      return { ...state, connected: false };

    case "stream-heartbeat":
      return { ...state, lastServerMessageAt: action.receivedAt };

    case "issues-snapshot":
      return {
        ...state,
        lastServerMessageAt: action.receivedAt,
        issues: action.issues,
        selectedIndex: Math.min(state.selectedIndex, Math.max(0, action.issues.length - 1)),
      };

    case "feed-event":
      return applyFeedEvent(state, action.event, action.receivedAt);

    case "select":
      return {
        ...state,
        selectedIndex: Math.max(0, Math.min(action.index, state.issues.length - 1)),
      };

    case "enter-detail":
      return { ...state, view: "detail", activeDetailKey: action.issueKey, ...DETAIL_INITIAL };

    case "exit-detail":
      return { ...state, view: "list", activeDetailKey: null, ...DETAIL_INITIAL };

    case "detail-navigate": {
      const list = action.filtered;
      if (list.length === 0) return state;
      const curIdx = list.findIndex((i) => i.issueKey === state.activeDetailKey);
      const nextIdx = action.direction === "next"
        ? (curIdx + 1) % list.length
        : (curIdx - 1 + list.length) % list.length;
      const nextIssue = list[nextIdx];
      if (!nextIssue?.issueKey || nextIssue.issueKey === state.activeDetailKey) return state;
      return { ...state, activeDetailKey: nextIssue.issueKey, selectedIndex: nextIdx, ...DETAIL_INITIAL };
    }

    case "timeline-rehydrate": {
      const timeline = buildTimelineFromRehydration(
        action.runs,
        action.feedEvents,
        action.liveThread,
        action.activeRunId,
      );
      const activeRun = action.runs.find((r) => r.id === action.activeRunId);
      return {
        ...state,
        timeline,
        rawRuns: action.runs,
        rawFeedEvents: action.feedEvents,
        activeRunId: action.activeRunId,
        activeRunStartedAt: action.activeRunStartedAt ?? activeRun?.startedAt ?? null,
        issueContext: action.issueContext,
      };
    }

    case "codex-notification":
      return applyCodexNotification(state, action.method, action.params);

    case "cycle-filter":
      return { ...state, filter: nextFilter(state.filter), selectedIndex: 0 };

    case "toggle-follow":
      return { ...state, follow: !state.follow };

    case "enter-feed":
      return { ...state, view: "feed", activeDetailKey: null, ...DETAIL_INITIAL };

    case "exit-feed":
      return { ...state, view: "list" };

    case "feed-snapshot":
      return { ...state, feedEvents: action.events };

    case "feed-new-event":
      return { ...state, feedEvents: capArray([...state.feedEvents, action.event], MAX_FEED_EVENTS) };

    case "switch-detail-tab":
      return { ...state, detailTab: action.tab };

    default:
      return state;
  }
}

// ─── Feed Event → Issue List + Timeline ───────────────────────────

function applyFeedEvent(state: WatchState, event: OperatorFeedEvent, receivedAt: number): WatchState {
  if (!event.issueKey) {
    return { ...state, lastServerMessageAt: receivedAt };
  }

  const index = state.issues.findIndex((issue) => issue.issueKey === event.issueKey);
  if (index === -1) {
    return { ...state, lastServerMessageAt: receivedAt };
  }

  const updated = [...state.issues];
  const issue = { ...updated[index]! };

  if (event.kind === "stage" && event.stage) {
    issue.factoryState = event.stage;
  }
  if (event.kind === "stage" && event.status === "starting" && event.stage) {
    issue.activeRunType = event.stage;
  }
  if (event.kind === "turn") {
    if (event.status === "completed" || event.status === "failed") {
      issue.activeRunType = undefined;
      issue.latestRunStatus = event.status;
    }
  }
  if (event.kind === "github" && event.status) {
    if (event.status === "check_passed" || event.status === "check_failed") {
      issue.prCheckStatus = event.status === "check_passed" ? "passed" : "failed";
    }
    if (event.status === "ci_repair_queued") {
      issue.factoryState = "repairing_ci";
      issue.statusNote = event.detail ?? event.summary;
    }
    if (event.status === "queue_repair_queued") {
      issue.factoryState = "repairing_queue";
      issue.statusNote = event.detail ?? event.summary;
    }
    if (event.status === "repair_deduped" || event.status === "branch_not_advanced") {
      issue.statusNote = event.summary;
    }
  }
  if ((event.kind === "turn" || event.kind === "github") && event.status === "branch_not_advanced") {
    issue.statusNote = event.summary;
  }

  issue.updatedAt = event.at;
  updated[index] = issue;

  // Append to timeline and raw feed events if this event matches the active detail issue
  const isActiveDetail = state.view === "detail" && state.activeDetailKey === event.issueKey;
  const timeline = isActiveDetail
    ? capArray(appendFeedToTimeline(state.timeline, event), MAX_TIMELINE_ENTRIES)
    : state.timeline;
  const rawFeedEvents = isActiveDetail
    ? capArray([...state.rawFeedEvents, event], MAX_RAW_FEED_EVENTS)
    : state.rawFeedEvents;

  return { ...state, lastServerMessageAt: receivedAt, issues: updated, timeline, rawFeedEvents };
}

// ─── Codex Notification → Timeline + Metadata ─────────────────────

function applyCodexNotification(
  state: WatchState,
  method: string,
  params: Record<string, unknown>,
): WatchState {
  switch (method) {
    case "item/started":
      return { ...state, timeline: capArray(appendCodexItemToTimeline(state.timeline, params, state.activeRunId), MAX_TIMELINE_ENTRIES) };

    case "item/completed":
      return { ...state, timeline: completeCodexItemInTimeline(state.timeline, params) };

    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "item/reasoning/summaryTextDelta": {
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : undefined;
      if (!itemId || !delta) return state;
      return { ...state, timeline: appendDeltaToTimelineItem(state.timeline, itemId, "text", delta) };
    }

    case "item/commandExecution/outputDelta": {
      const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
      const delta = typeof params.delta === "string" ? params.delta : undefined;
      if (!itemId || !delta) return state;
      return { ...state, timeline: appendDeltaToTimelineItem(state.timeline, itemId, "output", delta) };
    }

    case "turn/plan/updated":
      return applyPlanUpdate(state, params);

    case "turn/diff/updated":
      return applyDiffUpdate(state, params);

    case "thread/tokenUsage/updated":
      return applyTokenUsageUpdate(state, params);

    default:
      return state;
  }
}

// ─── Metadata Handlers (header, not timeline) ─────────────────────

function applyPlanUpdate(state: WatchState, params: Record<string, unknown>): WatchState {
  const plan = params.plan;
  if (!Array.isArray(plan)) return state;
  return {
    ...state,
    plan: plan.map((entry) => {
      const e = entry as Record<string, unknown>;
      return {
        step: typeof e.step === "string" ? e.step : String(e.step ?? ""),
        status: typeof e.status === "string" ? e.status : "pending",
      };
    }),
  };
}

function applyDiffUpdate(state: WatchState, params: Record<string, unknown>): WatchState {
  const diff = typeof params.diff === "string" ? params.diff : undefined;
  if (!diff) return state;
  return { ...state, diffSummary: parseDiffSummary(diff) };
}

function parseDiffSummary(diff: string): WatchDiffSummary {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      files.add(line.slice(6));
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { filesChanged: files.size, linesAdded: added, linesRemoved: removed };
}

function applyTokenUsageUpdate(state: WatchState, params: Record<string, unknown>): WatchState {
  const usage = params.usage as Record<string, unknown> | undefined;
  if (!usage) return state;
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens
    : typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens
    : typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  return { ...state, tokenUsage: { inputTokens, outputTokens } };
}
