import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { TimelineRunInput } from "./timeline-builder.ts";

// ─── Types ───────────────────────────────────────────────────────

export interface HistoryRunInfo {
  id: number;
  runType: string;
  status: string; // "completed" | "failed" | "running" | "queued" | "released"
  startedAt: string;
  endedAt?: string | undefined;
  // Report summary (when available)
  messageCount?: number | undefined;
  commandCount?: number | undefined;
  fileChangeCount?: number | undefined;
  lastMessage?: string | undefined;
}

export interface SideTripNode {
  state: string;
  enteredAt: string;
  reason?: string | undefined;
  returnState: string;
  returnedAt?: string | undefined;
  runs: HistoryRunInfo[];
}

export interface StateHistoryNode {
  state: string;
  enteredAt: string;
  reason?: string | undefined;
  isCurrent: boolean;
  runs: HistoryRunInfo[];
  sideTrips: SideTripNode[];
}

// ─── Constants ───────────────────────────────────────────────────

const SIDE_TRIP_STATES = new Set(["changes_requested", "repairing_ci", "repairing_queue"]);

const RUN_TYPE_TO_STATE: Record<string, string> = {
  implementation: "implementing",
  ci_repair: "repairing_ci",
  review_fix: "changes_requested",
  branch_upkeep: "changes_requested",
  queue_repair: "repairing_queue",
};

// ─── State transition extraction ─────────────────────────────────

interface StateTransition {
  state: string;
  at: string;
  reason?: string | undefined;
}

function extractTransitions(feedEvents: OperatorFeedEvent[]): StateTransition[] {
  const transitions: StateTransition[] = [];

  for (const event of feedEvents) {
    if (!event.stage) continue;

    let state: string | undefined;
    let reason: string | undefined;

    if (event.kind === "stage") {
      if (event.status === "starting") {
        state = RUN_TYPE_TO_STATE[event.stage] ?? event.stage;
        reason = event.summary;
      } else if (event.status === "reconciled" || event.status === "retry" || event.status === "queued") {
        state = event.stage;
        reason = event.summary;
      }
    } else if (event.kind === "github") {
      state = event.stage;
      reason = event.summary;
    }

    if (state) {
      // Deduplicate consecutive identical states
      if (transitions.length > 0 && transitions[transitions.length - 1]!.state === state) {
        continue;
      }
      transitions.push({ state, at: event.at, reason });
    }
  }

  return transitions;
}

// ─── Run helpers ─────────────────────────────────────────────────

function toRunInfo(run: TimelineRunInput): HistoryRunInfo {
  const info: HistoryRunInfo = {
    id: run.id,
    runType: run.runType,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };

  if (run.report) {
    info.messageCount = run.report.assistantMessages.length;
    info.commandCount = run.report.commands.length;
    info.fileChangeCount = run.report.fileChanges.length;
    const lastMsg = run.report.assistantMessages[run.report.assistantMessages.length - 1];
    if (lastMsg) {
      info.lastMessage = lastMsg;
    }
  }

  return info;
}

function runToState(run: TimelineRunInput): string {
  return RUN_TYPE_TO_STATE[run.runType] ?? run.runType;
}

// ─── Build from runs only (no feed events) ───────────────────────

function buildFromRuns(
  runs: TimelineRunInput[],
  currentFactoryState: string,
): StateHistoryNode[] {
  if (runs.length === 0) return [];

  const nodes: StateHistoryNode[] = [];
  const earliest = runs[0]!;

  // Seed with delegated
  nodes.push({
    state: "delegated",
    enteredAt: earliest.startedAt,
    isCurrent: false,
    runs: [],
    sideTrips: [],
  });

  // Group consecutive runs by their mapped state.
  // When the state changes, create a new node.
  let currentState = "";
  let currentNode: StateHistoryNode | null = null;

  for (const run of runs) {
    const state = runToState(run);

    if (state !== currentState) {
      currentState = state;
      currentNode = {
        state,
        enteredAt: run.startedAt,
        isCurrent: false,
        runs: [toRunInfo(run)],
        sideTrips: [],
      };
      nodes.push(currentNode);
    } else {
      currentNode!.runs.push(toRunInfo(run));
    }
  }

  // If the current factory state differs from the last node's state,
  // add a final node (e.g., implementing → failed)
  const lastNodeState = nodes[nodes.length - 1]!.state;
  if (currentFactoryState !== lastNodeState && currentFactoryState !== "delegated") {
    const lastRun = runs[runs.length - 1]!;
    nodes.push({
      state: currentFactoryState,
      enteredAt: lastRun.endedAt ?? lastRun.startedAt,
      isCurrent: false,
      runs: [],
      sideTrips: [],
    });
  }

  return nodes;
}

// ─── Build from events + runs ────────────────────────────────────

function buildFromEvents(
  runs: TimelineRunInput[],
  transitions: StateTransition[],
  currentFactoryState: string,
): StateHistoryNode[] {
  // Build a chronological queue of runs per state
  const runQueues = new Map<string, HistoryRunInfo[]>();
  for (const run of runs) {
    const state = runToState(run);
    const queue = runQueues.get(state);
    if (queue) {
      queue.push(toRunInfo(run));
    } else {
      runQueues.set(state, [toRunInfo(run)]);
    }
  }

  function consumeNextRun(state: string): HistoryRunInfo[] {
    const queue = runQueues.get(state);
    if (!queue || queue.length === 0) return [];
    return [queue.shift()!];
  }

  const nodes: StateHistoryNode[] = [];
  let currentMainNode: StateHistoryNode | null = null;
  let currentSideTrip: SideTripNode | null = null;

  for (const t of transitions) {
    const isSideTrip = SIDE_TRIP_STATES.has(t.state);

    if (isSideTrip) {
      if (currentSideTrip) {
        closeSideTrip(currentMainNode, currentSideTrip, t.state, t.at);
      }
      currentSideTrip = {
        state: t.state,
        enteredAt: t.at,
        reason: t.reason,
        returnState: "",
        runs: [],
      };
    } else {
      if (currentSideTrip && currentMainNode) {
        currentSideTrip.runs = consumeNextRun(currentSideTrip.state);
        currentSideTrip.returnState = t.state;
        currentSideTrip.returnedAt = t.at;
        currentMainNode.sideTrips.push(currentSideTrip);
        currentSideTrip = null;
      }

      // Skip duplicate when returning from a side-trip to the same state
      if (currentMainNode && currentMainNode.state === t.state) {
        continue;
      }

      currentMainNode = {
        state: t.state,
        enteredAt: t.at,
        reason: t.reason,
        isCurrent: false,
        runs: consumeNextRun(t.state),
        sideTrips: [],
      };
      nodes.push(currentMainNode);
    }
  }

  // Close any open side-trip
  if (currentSideTrip && currentMainNode) {
    currentSideTrip.runs = consumeNextRun(currentSideTrip.state);
    currentSideTrip.returnState = currentFactoryState;
    currentMainNode.sideTrips.push(currentSideTrip);
  }

  // Distribute remaining unconsumed runs to matching nodes
  for (const [state, remaining] of runQueues) {
    if (remaining.length === 0) continue;

    // Find the last node (or side-trip) matching this state
    let target: StateHistoryNode | SideTripNode | undefined;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!;
      if (node.state === state) { target = node; break; }
      for (let j = node.sideTrips.length - 1; j >= 0; j--) {
        if (node.sideTrips[j]!.state === state) { target = node.sideTrips[j]; break; }
      }
      if (target) break;
    }

    if (target) {
      target.runs.push(...remaining);
    }
    remaining.length = 0;
  }

  return nodes;
}

// ─── Main entry point ────────────────────────────────────────────

export function buildStateHistory(
  runs: TimelineRunInput[],
  feedEvents: OperatorFeedEvent[],
  currentFactoryState: string,
  activeRunId: number | null,
): StateHistoryNode[] {
  const transitions = extractTransitions(feedEvents);

  const nodes = transitions.length > 0
    ? buildFromEvents(runs, transitions, currentFactoryState)
    : buildFromRuns(runs, currentFactoryState);

  if (nodes.length === 0) return [];

  markCurrent(nodes, currentFactoryState);

  if (activeRunId !== null) {
    markActiveRun(nodes, activeRunId);
  }

  return nodes;
}

// ─── Helpers ─────────────────────────────────────────────────────

function closeSideTrip(
  mainNode: StateHistoryNode | null,
  sideTrip: SideTripNode,
  returnState: string,
  returnedAt: string,
): void {
  if (!mainNode) return;
  sideTrip.returnState = returnState;
  sideTrip.returnedAt = returnedAt;
  mainNode.sideTrips.push(sideTrip);
}

function markCurrent(nodes: StateHistoryNode[], currentState: string): void {
  if (SIDE_TRIP_STATES.has(currentState)) {
    if (nodes.length > 0) {
      nodes[nodes.length - 1]!.isCurrent = true;
    }
    return;
  }

  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i]!.state === currentState) {
      nodes[i]!.isCurrent = true;
      return;
    }
  }

  if (nodes.length > 0) {
    nodes[nodes.length - 1]!.isCurrent = true;
  }
}

function markActiveRun(nodes: StateHistoryNode[], activeRunId: number): void {
  for (const node of nodes) {
    for (const run of node.runs) {
      if (run.id === activeRunId) {
        run.status = "running";
        return;
      }
    }
    for (const trip of node.sideTrips) {
      for (const run of trip.runs) {
        if (run.id === activeRunId) {
          run.status = "running";
          return;
        }
      }
    }
  }
}
