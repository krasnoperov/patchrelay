import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type {
  TimelineEntry,
  TimelineRunInput,
} from "./timeline-builder.ts";
import {
  reconcileTimelineFromRehydration,
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
  prState?: string | undefined;
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
  completionCheckActive?: boolean | undefined;
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

export type WatchView = "list" | "detail" | "log";

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
  detailScrollOffset: number;
  detailViewportRows: number;
  detailContentRows: number;
  detailUnreadBelow: number;
  timeline: TimelineEntry[];
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  activeRunId: number | null;
  activeRunStartedAt: string | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
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
  | { type: "enter-log" }
  | { type: "exit-log" }
  | { type: "detail-navigate"; direction: "next" | "prev"; filtered: WatchIssue[] }
  | { type: "detail-scroll"; delta: number }
  | { type: "detail-page"; direction: "up" | "down" }
  | { type: "detail-jump"; target: "start" | "end" }
  | { type: "detail-layout-updated"; viewportRows: number; contentRows: number }
  | { type: "timeline-rehydrate"; runs: TimelineRunInput[]; feedEvents: OperatorFeedEvent[]; liveThread: CodexThreadSummary | null; activeRunId: number | null; activeRunStartedAt?: string | null; issueContext: WatchIssueContext | null }
  | { type: "codex-notification"; method: string; params: Record<string, unknown> }
  | { type: "cycle-filter" }
  | { type: "toggle-follow" }
  | { type: "switch-detail-tab"; tab: DetailTab };

// ─── Array size caps (prevent OOM) ───────────────────────────────

const MAX_TIMELINE_ENTRIES = 2000;
const MAX_RAW_FEED_EVENTS = 2000;

function capArray<T>(arr: T[], max: number): T[] {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

const DETAIL_INITIAL = {
  detailTab: "timeline" as DetailTab,
  detailScrollOffset: 0,
  detailViewportRows: 0,
  detailContentRows: 0,
  detailUnreadBelow: 0,
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
};

const TERMINAL_FACTORY_STATES = new Set(["done", "failed"]);

function effectiveSessionState(issue: WatchIssue): string | undefined {
  return issue.sessionState ?? (TERMINAL_FACTORY_STATES.has(issue.factoryState) ? issue.factoryState : undefined);
}

export function filterIssues(issues: WatchIssue[], filter: WatchFilter): WatchIssue[] {
  switch (filter) {
    case "all":
      return issues;
    case "active":
      return issues.filter((i) => i.activeRunType !== undefined);
    case "non-done":
      return issues.filter((i) => {
        const sessionState = effectiveSessionState(i);
        return sessionState !== "done" && sessionState !== "failed" && !TERMINAL_FACTORY_STATES.has(i.factoryState);
      });
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
    const sessionState = effectiveSessionState(issue);
    const isDone = sessionState === "done" || DONE_STATES.has(issue.factoryState);
    const isFailed = sessionState === "failed" || FAILED_STATES.has(issue.factoryState);
    if (issue.activeRunType) active++;
    if (!issue.activeRunType && issue.blockedByCount > 0) blocked++;
    if (!issue.activeRunType && issue.prNumber === undefined && issue.readyForExecution && !isDone && !isFailed) ready++;
    if (isDone) done++;
    if (isFailed) failed++;
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

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

function selectedIssueKeyForFilter(state: WatchState): string | null {
  const filtered = filterIssues(state.issues, state.filter);
  return filtered[state.selectedIndex]?.issueKey ?? null;
}

function selectedIndexForSnapshot(state: WatchState, nextIssues: WatchIssue[]): number {
  const nextFiltered = filterIssues(nextIssues, state.filter);
  if (nextFiltered.length === 0) return 0;

  const selectedIssueKey = selectedIssueKeyForFilter(state);
  if (selectedIssueKey) {
    const selectedIndex = nextFiltered.findIndex((issue) => issue.issueKey === selectedIssueKey);
    if (selectedIndex >= 0) return selectedIndex;
  }

  return clampIndex(state.selectedIndex, nextFiltered.length);
}

const DETAIL_BOTTOM_THRESHOLD = 2;

function maxDetailScrollOffset(contentRows: number, viewportRows: number): number {
  return Math.max(0, contentRows - viewportRows);
}

function isDetailNearBottom(scrollOffset: number, contentRows: number, viewportRows: number): boolean {
  const maxOffset = maxDetailScrollOffset(contentRows, viewportRows);
  return scrollOffset >= Math.max(0, maxOffset - DETAIL_BOTTOM_THRESHOLD);
}

function detailStateForPosition(
  state: WatchState,
  scrollOffset: number,
  follow: boolean,
): Pick<WatchState, "detailScrollOffset" | "detailUnreadBelow" | "follow"> {
  const maxOffset = maxDetailScrollOffset(state.detailContentRows, state.detailViewportRows);
  const nextOffset = clampIndex(scrollOffset, maxOffset + 1);
  const nextFollow = follow || isDetailNearBottom(nextOffset, state.detailContentRows, state.detailViewportRows);
  return {
    detailScrollOffset: nextFollow ? maxOffset : nextOffset,
    detailUnreadBelow: nextFollow ? 0 : Math.max(0, maxOffset - nextOffset),
    follow: nextFollow,
  };
}

function detailStateAfterLayout(
  state: WatchState,
  viewportRows: number,
  contentRows: number,
): Pick<WatchState, "detailScrollOffset" | "detailViewportRows" | "detailContentRows" | "detailUnreadBelow" | "follow"> {
  const nextState = {
    ...state,
    detailViewportRows: Math.max(0, viewportRows),
    detailContentRows: Math.max(0, contentRows),
  };
  const maxOffset = maxDetailScrollOffset(nextState.detailContentRows, nextState.detailViewportRows);
  const shouldFollow = state.follow;
  const nextOffset = shouldFollow ? maxOffset : Math.min(state.detailScrollOffset, maxOffset);
  return {
    detailViewportRows: nextState.detailViewportRows,
    detailContentRows: nextState.detailContentRows,
    detailScrollOffset: nextOffset,
    detailUnreadBelow: shouldFollow ? 0 : Math.max(0, maxOffset - nextOffset),
    follow: shouldFollow,
  };
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
        selectedIndex: selectedIndexForSnapshot(state, action.issues),
      };

    case "feed-event":
      return applyFeedEvent(state, action.event, action.receivedAt);

    case "select":
      return {
        ...state,
        selectedIndex: clampIndex(action.index, filterIssues(state.issues, state.filter).length),
      };

    case "enter-detail":
      return { ...state, view: "detail", activeDetailKey: action.issueKey, follow: true, ...DETAIL_INITIAL };

    case "exit-detail":
      return { ...state, view: "list", activeDetailKey: null, ...DETAIL_INITIAL };

    case "enter-log":
      if (state.view !== "detail" || !state.activeDetailKey) return state;
      return { ...state, view: "log", follow: true, detailScrollOffset: 0 };

    case "exit-log":
      if (state.view !== "log") return state;
      return { ...state, view: "detail", follow: true, detailScrollOffset: 0 };

    case "detail-navigate": {
      const list = action.filtered;
      if (list.length === 0) return state;
      const curIdx = list.findIndex((i) => i.issueKey === state.activeDetailKey);
      const nextIdx = action.direction === "next"
        ? (curIdx + 1) % list.length
        : (curIdx - 1 + list.length) % list.length;
      const nextIssue = list[nextIdx];
      if (!nextIssue?.issueKey || nextIssue.issueKey === state.activeDetailKey) return state;
      return { ...state, activeDetailKey: nextIssue.issueKey, selectedIndex: nextIdx, follow: true, ...DETAIL_INITIAL };
    }

    case "detail-scroll":
      return {
        ...state,
        ...detailStateForPosition(state, state.detailScrollOffset + action.delta, false),
      };

    case "detail-page": {
      const pageSize = Math.max(1, state.detailViewportRows - 2);
      const delta = action.direction === "down" ? pageSize : -pageSize;
      return {
        ...state,
        ...detailStateForPosition(state, state.detailScrollOffset + delta, false),
      };
    }

    case "detail-jump":
      return action.target === "end"
        ? {
            ...state,
            ...detailStateForPosition(
              state,
              maxDetailScrollOffset(state.detailContentRows, state.detailViewportRows),
              true,
            ),
          }
        : {
            ...state,
            ...detailStateForPosition(state, 0, false),
          };

    case "detail-layout-updated":
    {
      const nextDetailState = detailStateAfterLayout(state, action.viewportRows, action.contentRows);
      if (
        nextDetailState.detailViewportRows === state.detailViewportRows
        && nextDetailState.detailContentRows === state.detailContentRows
        && nextDetailState.detailScrollOffset === state.detailScrollOffset
        && nextDetailState.detailUnreadBelow === state.detailUnreadBelow
        && nextDetailState.follow === state.follow
      ) {
        return state;
      }
      return {
        ...state,
        ...nextDetailState,
      };
    }

    case "timeline-rehydrate": {
      const timeline = reconcileTimelineFromRehydration(
        state.timeline,
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
      return state.follow
        ? {
            ...state,
            follow: false,
            detailUnreadBelow: Math.max(
              0,
              maxDetailScrollOffset(state.detailContentRows, state.detailViewportRows) - state.detailScrollOffset,
            ),
          }
        : {
            ...state,
            ...detailStateForPosition(
              state,
              maxDetailScrollOffset(state.detailContentRows, state.detailViewportRows),
              true,
            ),
          };

    case "switch-detail-tab":
      return { ...state, follow: true, ...DETAIL_INITIAL, detailTab: action.tab };

    default:
      return state;
  }
}

// ─── Feed Event → Issue List + Timeline ───────────────────────────

function applyFeedEvent(state: WatchState, event: OperatorFeedEvent, receivedAt: number): WatchState {
  const isActiveDetail = Boolean(event.issueKey)
    && state.view === "detail"
    && state.activeDetailKey === event.issueKey;
  const timeline = isActiveDetail
    ? capArray(appendFeedToTimeline(state.timeline, event), MAX_TIMELINE_ENTRIES)
    : state.timeline;
  const rawFeedEvents = isActiveDetail
    ? capArray([...state.rawFeedEvents, event], MAX_RAW_FEED_EVENTS)
    : state.rawFeedEvents;
  return { ...state, lastServerMessageAt: receivedAt, timeline, rawFeedEvents };
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
