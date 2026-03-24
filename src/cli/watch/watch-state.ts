import type { OperatorFeedEvent } from "../../operator-feed.ts";

export interface WatchIssue {
  issueKey?: string | undefined;
  title?: string | undefined;
  projectId: string;
  factoryState: string;
  currentLinearState?: string | undefined;
  activeRunType?: string | undefined;
  latestRunType?: string | undefined;
  latestRunStatus?: string | undefined;
  prNumber?: number | undefined;
  prReviewState?: string | undefined;
  prCheckStatus?: string | undefined;
  updatedAt: string;
}

export interface WatchState {
  connected: boolean;
  issues: WatchIssue[];
  selectedIndex: number;
  view: "list" | "detail";
  activeDetailKey: string | null;
}

export type WatchAction =
  | { type: "connected" }
  | { type: "disconnected" }
  | { type: "issues-snapshot"; issues: WatchIssue[] }
  | { type: "feed-event"; event: OperatorFeedEvent }
  | { type: "select"; index: number }
  | { type: "enter-detail"; issueKey: string }
  | { type: "exit-detail" };

export const initialWatchState: WatchState = {
  connected: false,
  issues: [],
  selectedIndex: 0,
  view: "list",
  activeDetailKey: null,
};

export function watchReducer(state: WatchState, action: WatchAction): WatchState {
  switch (action.type) {
    case "connected":
      return { ...state, connected: true };

    case "disconnected":
      return { ...state, connected: false };

    case "issues-snapshot":
      return {
        ...state,
        issues: action.issues,
        selectedIndex: Math.min(state.selectedIndex, Math.max(0, action.issues.length - 1)),
      };

    case "feed-event":
      return applyFeedEvent(state, action.event);

    case "select":
      return {
        ...state,
        selectedIndex: Math.max(0, Math.min(action.index, state.issues.length - 1)),
      };

    case "enter-detail":
      return { ...state, view: "detail", activeDetailKey: action.issueKey };

    case "exit-detail":
      return { ...state, view: "list", activeDetailKey: null };
  }
}

function applyFeedEvent(state: WatchState, event: OperatorFeedEvent): WatchState {
  if (!event.issueKey) {
    return state;
  }

  const index = state.issues.findIndex((issue) => issue.issueKey === event.issueKey);
  if (index === -1) {
    return state;
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
  }

  issue.updatedAt = event.at;
  updated[index] = issue;

  return { ...state, issues: updated };
}
