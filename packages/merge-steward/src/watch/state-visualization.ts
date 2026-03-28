import type { QueueEntry, QueueEntryDetail } from "../types.ts";

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

const MAIN_STATES = ["queued", "preparing_head", "validating", "merging", "merged"] as const;
const EXIT_STATES = ["evicted", "dequeued"] as const;

const STATE_LABELS: Record<string, string> = {
  queued: "queued",
  preparing_head: "preparing_head",
  validating: "validating",
  merging: "merging",
  merged: "merged",
  evicted: "evicted",
  dequeued: "dequeued",
};

function labelForState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function buildNodes(
  states: readonly string[],
  visited: Set<string>,
  currentStatus: string,
): VisualizationNode[] {
  return states.map((state) => ({
    state,
    label: labelForState(state),
    status: currentStatus === state
      ? "current"
      : visited.has(state)
        ? "visited"
        : "upcoming",
  }));
}

function collectVisitedStates(detail: QueueEntryDetail): Set<string> {
  const visited = new Set<string>([detail.entry.status]);
  for (const event of detail.events) {
    if (event.fromStatus) {
      visited.add(event.fromStatus);
    }
    visited.add(event.toStatus);
  }
  return visited;
}

export function buildEntryStateGraph(detail: QueueEntryDetail): {
  main: VisualizationNode[];
  exits: VisualizationNode[];
} {
  const visited = collectVisitedStates(detail);
  return {
    main: buildNodes(MAIN_STATES, visited, detail.entry.status),
    exits: buildNodes(EXIT_STATES, visited, detail.entry.status),
  };
}

export function buildExternalRepairObservations(
  detail: QueueEntryDetail,
  options: {
    isHead: boolean;
    activeIndex: number | null;
    activeCount: number;
    headPrNumber: number | null;
  },
): ObservationLine[] {
  const { entry, incidents } = detail;
  const observations: ObservationLine[] = [];

  if (entry.status === "merged") {
    observations.push({
      tone: "success",
      text: "Merged by steward; no further queue action is required for this entry.",
    });
  } else if (entry.status === "dequeued") {
    observations.push({
      tone: "info",
      text: "Removed from the queue without merge; steward will not advance this entry further.",
    });
  } else if (entry.status === "evicted") {
    observations.push({
      tone: "warn",
      text: "Evicted after steward retries; external branch repair is expected before any later re-admission.",
    });
  } else if (options.isHead) {
    observations.push({
      tone: "info",
      text: "Head-of-line entry; steward can advance this PR on the next reconcile tick.",
    });
  } else if (options.activeIndex !== null && options.headPrNumber !== null) {
    observations.push({
      tone: "info",
      text: `Waiting behind current head #${options.headPrNumber} as active entry ${options.activeIndex} of ${options.activeCount}.`,
    });
  } else {
    observations.push({
      tone: "info",
      text: "Queued for serial processing by the steward.",
    });
  }

  const latestIncident = incidents[incidents.length - 1];
  if (latestIncident) {
    observations.push({
      tone: latestIncident.outcome === "open" ? "warn" : "info",
      text: `Latest failure class: ${latestIncident.failureClass} (${latestIncident.outcome}).`,
    });
  }

  if (entry.lastFailedBaseSha) {
    observations.push({
      tone: "warn",
      text: `Waiting for ${entry.lastFailedBaseSha.slice(0, 7)} on base to change before retrying rebase.`,
    });
  } else if (entry.status === "validating") {
    observations.push({
      tone: "info",
      text: "Waiting on validation CI for the refreshed head branch.",
    });
  } else if (entry.status === "merging") {
    observations.push({
      tone: "info",
      text: "Validation passed; steward is attempting the GitHub merge.",
    });
  }

  if (entry.generation > 0) {
    observations.push({
      tone: "info",
      text: `Observed ${entry.generation} branch head update${entry.generation === 1 ? "" : "s"} since first admission.`,
    });
  }

  return observations.slice(0, 4);
}
