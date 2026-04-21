import type { StateHistoryNode } from "./history-builder.ts";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import { hasOpenPr } from "../../pr-state.ts";
import { derivePrDisplayContext } from "../../pr-display-context.ts";

export type VisualizationNodeStatus = "current" | "visited" | "upcoming";

export interface VisualizationNode {
  state: string;
  label: string;
  status: VisualizationNodeStatus;
}

export interface ObservationLine {
  tone: "info" | "warn" | "success";
  text: string;
}

export interface PatchRelayObservationIssue {
  sessionState?: string | undefined;
  waitingReason?: string | undefined;
  factoryState: string;
  activeRunType?: string | undefined;
  prNumber?: number | undefined;
  prState?: string | undefined;
  prReviewState?: string | undefined;
}

const STATE_LABELS: Record<string, string> = {
  delegated: "delegated",
  implementing: "implementing",
  pr_open: "pr_open",
  changes_requested: "changes_requested",
  repairing_ci: "repairing_ci",
  awaiting_queue: "awaiting_queue",
  repairing_queue: "repairing_queue",
  awaiting_input: "awaiting_input",
  escalated: "escalated",
  done: "done",
  failed: "failed",
};

const MAIN_STATES = ["delegated", "implementing", "pr_open", "awaiting_queue", "done"] as const;
const PR_LOOP_STATES = ["changes_requested", "repairing_ci"] as const;
const QUEUE_LOOP_STATES = ["repairing_queue"] as const;
const EXIT_STATES = ["awaiting_input", "escalated", "failed"] as const;
const QUEUE_EVENT_STATUSES = new Set([
  "queue_repair_queued",
  "pr_merged",
]);

function labelForState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function collectVisitedStates(history: StateHistoryNode[], currentFactoryState: string): Set<string> {
  const visited = new Set<string>([currentFactoryState]);
  for (const node of history) {
    visited.add(node.state);
    for (const sideTrip of node.sideTrips) {
      visited.add(sideTrip.state);
      visited.add(sideTrip.returnState);
    }
  }
  return visited;
}

function buildNodes(
  states: readonly string[],
  visited: Set<string>,
  currentFactoryState: string,
): VisualizationNode[] {
  return states.map((state) => ({
    state,
    label: labelForState(state),
    status: currentFactoryState === state
      ? "current"
      : visited.has(state)
        ? "visited"
        : "upcoming",
  }));
}

function isQueueCheckFailure(event: OperatorFeedEvent): boolean {
  if (event.kind !== "github" || event.status !== "check_failed") {
    return false;
  }
  const haystack = `${event.summary} ${event.detail ?? ""}`;
  return haystack.includes("merge-steward/queue");
}

function latestQueueObservationEvent(feedEvents: OperatorFeedEvent[]): OperatorFeedEvent | undefined {
  const queueEvents = feedEvents.filter((event) =>
    QUEUE_EVENT_STATUSES.has(event.status ?? "") || isQueueCheckFailure(event)
    || (event.kind === "stage" && event.stage === "repairing_queue"),
  );
  return queueEvents[queueEvents.length - 1];
}

function describeObservationEvent(event: OperatorFeedEvent): ObservationLine {
  switch (event.status) {
    case "queue_repair_queued":
      return { tone: "warn", text: event.summary };
    case "pr_merged":
      return { tone: "success", text: "GitHub reports the PR was merged." };
    default:
      if (isQueueCheckFailure(event)) {
        return {
          tone: "warn",
          text: `External queue reported failure via ${event.detail ?? "merge-steward/queue"}.`,
        };
      }
      if (event.kind === "stage" && event.stage === "repairing_queue") {
        const active = event.status === "starting";
        return {
          tone: active ? "warn" : "info",
          text: active ? "PatchRelay is actively running queue repair." : `Observed queue signal: ${event.summary}`,
        };
      }
      return { tone: "info", text: `Observed signal: ${event.summary}` };
  }
}

export function buildPatchRelayStateGraph(history: StateHistoryNode[], currentFactoryState: string): {
  main: VisualizationNode[];
  prLoops: VisualizationNode[];
  queueLoop: VisualizationNode[];
  exits: VisualizationNode[];
} {
  const visited = collectVisitedStates(history, currentFactoryState);
  return {
    main: buildNodes(MAIN_STATES, visited, currentFactoryState),
    prLoops: buildNodes(PR_LOOP_STATES, visited, currentFactoryState),
    queueLoop: buildNodes(QUEUE_LOOP_STATES, visited, currentFactoryState),
    exits: buildNodes(EXIT_STATES, visited, currentFactoryState),
  };
}

export function buildPatchRelayQueueObservations(
  issue: PatchRelayObservationIssue,
  feedEvents: OperatorFeedEvent[],
): ObservationLine[] {
  const observations: ObservationLine[] = [];

  switch (issue.sessionState) {
    case "waiting_input":
      observations.push({
        tone: "warn",
        text: issue.waitingReason ?? "PatchRelay is waiting for input before continuing.",
      });
      break;
    case "running":
      observations.push({
        tone: "info",
        text: "PatchRelay is actively working this session.",
      });
      break;
    case "idle":
      observations.push({
        tone: "info",
        text: "PatchRelay is idle for this issue.",
      });
      break;
    case "done":
      observations.push({
        tone: "success",
        text: "PatchRelay is complete because GitHub reports the PR has merged.",
      });
      break;
    case "failed":
      observations.push({
        tone: "warn",
        text: "PatchRelay needs human help to recover this session.",
      });
      break;
    default:
      switch (issue.factoryState) {
    case "awaiting_queue":
      observations.push({
        tone: "info",
        text: "PatchRelay has finished active work. Delivery now depends on downstream review and merge automation.",
      });
      break;
    case "repairing_queue":
      observations.push({
        tone: issue.activeRunType === "queue_repair" ? "warn" : "info",
        text: issue.activeRunType === "queue_repair"
          ? "PatchRelay is actively repairing a queue eviction."
          : "PatchRelay is preparing or waiting to resume queue repair.",
      });
      break;
    case "done":
      observations.push({
        tone: "success",
        text: "PatchRelay is complete because GitHub reports the PR has merged.",
      });
      break;
    default:
      observations.push({
        tone: "info",
        text: "PatchRelay is tracking this issue.",
      });
      break;
      }
      break;
  }

  const latestEvent = latestQueueObservationEvent(feedEvents);
  if (latestEvent) {
    observations.push(describeObservationEvent(latestEvent));
  } else if (issue.factoryState === "awaiting_queue") {
    observations.push({
      tone: "info",
      text: "No downstream queue signal has been observed yet.",
    });
  }

  if (issue.prNumber !== undefined) {
    const prContext = derivePrDisplayContext(issue);
    let prLabel: string;
    switch (prContext.kind) {
      case "active_pr":
      case "merged_pr":
        prLabel = hasOpenPr(issue.prNumber, issue.prState)
          ? `Tracked PR: #${issue.prNumber}`
          : `Tracked PR: #${issue.prNumber}${issue.prState ? ` (${issue.prState})` : ""}`;
        break;
      case "closed_historical_pr":
        prLabel = `Previous PR: #${prContext.prNumber} (closed)`;
        break;
      case "closed_replacement_pending":
        prLabel = `Previous PR: #${prContext.prNumber} (closed; replacement pending)`;
        break;
      case "closed_pr_paused":
        prLabel = `Previous PR: #${prContext.prNumber} (closed; redelegate to replace)`;
        break;
      case "no_pr":
        prLabel = "PR context unavailable";
        break;
    }
    observations.push({
      tone: "info",
      text: `${prLabel}${issue.prReviewState ? ` (${issue.prReviewState})` : ""}`,
    });
  }

  return observations.slice(0, 3);
}
