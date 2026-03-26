import type { OperatorFeedEvent } from "../../operator-feed.ts";
import type { TimelineRunInput } from "./timeline-builder.ts";

// ─── Types ───────────────────────────────────────────────────────

export interface HistoryRunInfo {
  id: number;
  runType: string;
  status: string; // "completed" | "failed" | "running" | "queued" | "released"
  startedAt: string;
  endedAt?: string | undefined;
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
        // stage field is runType, map to factory state
        state = RUN_TYPE_TO_STATE[event.stage] ?? event.stage;
        reason = event.summary;
      } else if (event.status === "reconciled" || event.status === "retry" || event.status === "queued") {
        state = event.stage;
        reason = event.summary;
      }
    } else if (event.kind === "github") {
      // stage field is the factory state AFTER the transition
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

// ─── Run matching ────────────────────────────────────────────────

function buildRunQueue(runs: TimelineRunInput[]): Map<string, HistoryRunInfo[]> {
  // Group runs by their corresponding factory state, preserving chronological order.
  // Each call to consumeNextRun() pops from the front.
  const map = new Map<string, HistoryRunInfo[]>();

  for (const run of runs) {
    const state = RUN_TYPE_TO_STATE[run.runType] ?? run.runType;
    const info: HistoryRunInfo = {
      id: run.id,
      runType: run.runType,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    };
    const list = map.get(state);
    if (list) {
      list.push(info);
    } else {
      map.set(state, [info]);
    }
  }

  return map;
}

// ─── Tree builder ────────────────────────────────────────────────

export function buildStateHistory(
  runs: TimelineRunInput[],
  feedEvents: OperatorFeedEvent[],
  currentFactoryState: string,
  activeRunId: number | null,
): StateHistoryNode[] {
  const transitions = extractTransitions(feedEvents);
  const runQueue = buildRunQueue(runs);

  function consumeNextRun(state: string): HistoryRunInfo[] {
    const queue = runQueue.get(state);
    if (!queue || queue.length === 0) return [];
    const run = queue.shift();
    return run ? [run] : [];
  }

  // Walk transitions and build nodes
  const nodes: StateHistoryNode[] = [];
  let currentMainNode: StateHistoryNode | null = null;
  let currentSideTrip: SideTripNode | null = null;

  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i]!;
    const isSideTrip = SIDE_TRIP_STATES.has(t.state);

    if (isSideTrip) {
      // Start or continue a side-trip
      if (currentSideTrip) {
        // Close previous side-trip first (nested side-trip is rare but handle it)
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
      // Main-path state
      if (currentSideTrip && currentMainNode) {
        // Close the active side-trip — we're returning to the main path
        // Consume runs for the side-trip state now
        currentSideTrip.runs = consumeNextRun(currentSideTrip.state);
        currentSideTrip.returnState = t.state;
        currentSideTrip.returnedAt = t.at;
        currentMainNode.sideTrips.push(currentSideTrip);
        currentSideTrip = null;
      }

      // Skip duplicate main-path nodes if returning to the same state (e.g., pr_open → changes_requested → pr_open)
      if (currentMainNode && currentMainNode.state === t.state) {
        // Same main-path state revisited — don't create a new node
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

  // If we ended in a side-trip (e.g., currently repairing_ci), close it
  if (currentSideTrip && currentMainNode) {
    currentSideTrip.runs = consumeNextRun(currentSideTrip.state);
    currentSideTrip.returnState = currentFactoryState;
    currentMainNode.sideTrips.push(currentSideTrip);
  }

  // Handle edge case: no transitions extracted but we have runs
  if (nodes.length === 0 && runs.length > 0) {
    // Seed with delegated state from earliest run
    const earliest = runs[0]!;
    nodes.push({
      state: "delegated",
      enteredAt: earliest.startedAt,
      isCurrent: currentFactoryState === "delegated",
      runs: [],
      sideTrips: [],
    });

    const implState = RUN_TYPE_TO_STATE[earliest.runType] ?? "implementing";
    nodes.push({
      state: implState,
      enteredAt: earliest.startedAt,
      isCurrent: currentFactoryState === implState,
      runs: consumeNextRun(implState),
      sideTrips: [],
    });
  }

  // Mark the current state
  markCurrent(nodes, currentFactoryState);

  // Mark active run
  if (activeRunId !== null) {
    markActiveRun(nodes, activeRunId);
  }

  return nodes;
}

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
  // If current state is a side-trip state, mark the last main node as current
  // (the side-trip is "in progress" from that main node)
  if (SIDE_TRIP_STATES.has(currentState)) {
    if (nodes.length > 0) {
      nodes[nodes.length - 1]!.isCurrent = true;
    }
    return;
  }

  // Find the last node matching the current state
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i]!.state === currentState) {
      nodes[i]!.isCurrent = true;
      return;
    }
  }

  // Fallback: mark the last node
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
