import type { QueueBlockState, QueueEntry, QueueEntryDetail } from "../types.ts";

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
  preparing_head: "preparing",
  validating: "testing",
  merging: "merging",
  merged: "merged",
  evicted: "evicted",
  dequeued: "removed",
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
    queueBlock: QueueBlockState | null;
  },
): ObservationLine[] {
  const { entry, incidents } = detail;
  const observations: ObservationLine[] = [];

  // What is this entry doing right now?
  if (entry.status === "merged") {
    observations.push({ tone: "success", text: "Landed on main." });
  } else if (entry.status === "dequeued") {
    observations.push({ tone: "info", text: "Removed from queue." });
  } else if (entry.status === "evicted") {
    observations.push({ tone: "warn", text: "Removed after failed retries. Branch needs repair before re-admission." });
  } else if (options.isHead && options.queueBlock?.reason === "main_broken") {
    const failingNames = options.queueBlock.failingChecks.map((check) => check.name);
    const pendingNames = options.queueBlock.pendingChecks.map((check) => check.name);
    const missingNames = options.queueBlock.missingRequiredChecks;
    const detail = [
      missingNames.length > 0 ? `missing required ${missingNames.join(", ")}` : null,
      failingNames.length > 0 ? `failing ${failingNames.join(", ")}` : null,
      pendingNames.length > 0 ? `pending ${pendingNames.join(", ")}` : null,
    ].filter(Boolean).join("; ");
    observations.push({
      tone: "warn",
      text: missingNames.length > 0
        ? `Queue paused: ${options.queueBlock.baseBranch} is missing required checks${detail ? ` (${detail})` : ""}. Operator action is required on main before the queue can continue.`
        : pendingNames.length > 0 && failingNames.length === 0
          ? `Queue paused: ${options.queueBlock.baseBranch} is still verifying${detail ? ` (${detail})` : ""}. Will resume when checks settle.`
          : `Queue paused: ${options.queueBlock.baseBranch} is unhealthy${detail ? ` (${detail})` : ""}. Will resume when main is healthy.`,
    });
  } else if (options.isHead) {
    observations.push({ tone: "info", text: "First in queue. Will advance on the next tick." });
  } else if (options.activeIndex !== null && options.headPrNumber !== null) {
    observations.push({
      tone: "info",
      text: `Position ${options.activeIndex} of ${options.activeCount}. Being tested together with PRs ahead.`,
    });
  } else {
    observations.push({ tone: "info", text: "Waiting in queue." });
  }

  // What went wrong last time?
  const latestIncident = incidents[incidents.length - 1];
  if (latestIncident) {
    observations.push({
      tone: latestIncident.outcome === "open" ? "warn" : "info",
      text: `Last failure: ${latestIncident.failureClass} (${latestIncident.outcome}).`,
    });
  }

  // What is blocking progress?
  if (entry.lastFailedBaseSha) {
    observations.push({
      tone: "warn",
      text: "Conflicts with main. Will retry automatically when another PR merges and main advances.",
    });
  } else if (entry.status === "validating") {
    const cascadeNote = entry.specBasedOn
      ? " Tests pass → merges automatically when PRs ahead finish."
      : "";
    observations.push({
      tone: "info",
      text: `CI running on combined changes.${cascadeNote}`,
    });
  } else if (entry.status === "merging") {
    observations.push({ tone: "info", text: "CI passed. Landing on main." });
  }

  return observations.slice(0, 4);
}
