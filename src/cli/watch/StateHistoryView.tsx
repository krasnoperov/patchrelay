import { Box, Text } from "ink";
import type { StateHistoryNode, SideTripNode, HistoryRunInfo } from "./history-builder.ts";
import { planStepSymbol, planStepColor } from "./plan-helpers.ts";

interface StateHistoryViewProps {
  history: StateHistoryNode[];
  plan: Array<{ step: string; status: string }> | null;
  activeRunId: number | null;
}

// ─── Formatting helpers ──────────────────────────────────────────

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${minutes}m${s > 0 ? `${String(s).padStart(2, "0")}s` : ""}`;
}

const RUN_LABELS: Record<string, string> = {
  implementation: "implementation",
  main_repair: "main repair",
  ci_repair: "ci repair",
  review_fix: "review fix",
  branch_upkeep: "branch upkeep",
  queue_repair: "queue repair",
};

function runStatusSymbol(status: string): string {
  if (status === "completed") return "\u2713";
  if (status === "failed") return "\u2717";
  if (status === "running") return "\u25b8";
  return " ";
}

function runStatusColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "running") return "yellow";
  return "white";
}

const STATE_LABELS: Record<string, string> = {
  delegated: "delegated",
  implementing: "implementing",
  pr_open: "pr open",
  changes_requested: "changes requested",
  repairing_ci: "repairing ci",
  awaiting_queue: "awaiting queue",
  repairing_queue: "repairing queue",
  awaiting_input: "awaiting input",
  escalated: "escalated",
  done: "done",
  failed: "failed",
};

// ─── Sub-components ──────────────────────────────────────────────

function RunLine({ run, index, gutter }: { run: HistoryRunInfo; index: number; gutter: string }): React.JSX.Element {
  const label = RUN_LABELS[run.runType] ?? run.runType;
  const dur = run.endedAt
    ? formatDuration(run.startedAt, run.endedAt)
    : undefined;
  const isActive = run.status === "running";

  // Report stats
  const stats: string[] = [];
  if (run.messageCount !== undefined) stats.push(`${run.messageCount} msgs`);
  if (run.commandCount) stats.push(`${run.commandCount} cmds`);
  if (run.fileChangeCount) stats.push(`${run.fileChangeCount} files`);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={runStatusColor(run.status)}>{runStatusSymbol(run.status)} </Text>
        <Text dimColor>#{index + 1} </Text>
        <Text>({label})</Text>
        {dur && <Text dimColor> {dur}</Text>}
        {isActive && <Text dimColor> ...</Text>}
        {stats.length > 0 && <Text dimColor>  {stats.join(", ")}</Text>}
      </Box>
      {run.lastMessage && (
        <Box>
          <Text dimColor>{gutter}  </Text>
          <Text dimColor wrap="truncate">{run.lastMessage.slice(0, 120)}</Text>
        </Box>
      )}
    </Box>
  );
}

function RunSummary({ runs }: { runs: HistoryRunInfo[] }): React.JSX.Element {
  const completed = runs.filter((r) => r.status === "completed").length;
  const failed = runs.filter((r) => r.status === "failed").length;
  const running = runs.filter((r) => r.status === "running").length;
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} active`);
  return <Text dimColor>{runs.length} runs: {parts.join(", ")}</Text>;
}

function PlanSteps({ plan }: { plan: Array<{ step: string; status: string }> }): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {plan.map((entry, i) => (
        <Box key={`plan-${i}`} gap={1}>
          <Text color={planStepColor(entry.status)}>[{planStepSymbol(entry.status)}]</Text>
          <Text>{entry.step}</Text>
        </Box>
      ))}
    </Box>
  );
}

function SideTripBlock({
  trip,
  runOffset,
  isLast,
}: {
  trip: SideTripNode;
  runOffset: number;
  isLast: boolean;
}): React.JSX.Element {
  const stateLabel = STATE_LABELS[trip.state] ?? trip.state;
  const hasReturn = trip.returnedAt && trip.returnState !== trip.state;

  return (
    <Box flexDirection="column">
      {/* Entry line */}
      <Box>
        <Text dimColor>{" \u2502  \u250c "}</Text>
        <Text color="magenta" bold>{stateLabel}</Text>
        <Text dimColor>{"  "}{formatTime(trip.enteredAt)}</Text>
      </Box>

      {/* Reason */}
      {trip.reason && (
        <Box>
          <Text dimColor>{" \u2502  \u2502 "}</Text>
          <Text dimColor>{trip.reason}</Text>
        </Box>
      )}

      {/* Runs in this side-trip */}
      {trip.runs.map((run, ri) => (
        <Box key={`st-run-${run.id}`}>
          <Text dimColor>{" \u2502  \u2502 "}</Text>
          <RunLine run={run} index={runOffset + ri} gutter={" \u2502  \u2502"} />
        </Box>
      ))}

      {/* Return line */}
      {hasReturn ? (
        <Box>
          <Text dimColor>{" \u2502  \u2514\u2192 "}</Text>
          <Text>{STATE_LABELS[trip.returnState] ?? trip.returnState}</Text>
          {trip.returnedAt && <Text dimColor>{"  "}{formatTime(trip.returnedAt)}</Text>}
        </Box>
      ) : (
        <Box>
          <Text dimColor>{" \u2502  \u2514\u2500"}</Text>
          <Text dimColor> (active)</Text>
        </Box>
      )}

      {/* Spacer if not last side-trip */}
      {!isLast && (
        <Box><Text dimColor>{" \u2502"}</Text></Box>
      )}
    </Box>
  );
}

function MainPathNode({
  node,
  isLast,
  runOffset,
  plan,
  activeRunId,
}: {
  node: StateHistoryNode;
  isLast: boolean;
  runOffset: number;
  plan: Array<{ step: string; status: string }> | null;
  activeRunId: number | null;
}): React.JSX.Element {
  const stateLabel = STATE_LABELS[node.state] ?? node.state;
  const marker = node.isCurrent ? "\u25c9" : "\u25cb";
  const stateColor = node.isCurrent ? "green" : "white";
  const hasActiveRun = node.runs.some((r) => r.id === activeRunId);
  const gutter = isLast && node.sideTrips.length === 0 ? "   " : " \u2502 ";

  return (
    <Box flexDirection="column">
      {/* State line */}
      <Box>
        <Text color={stateColor} bold={node.isCurrent}> {marker} </Text>
        <Text color={stateColor} bold={node.isCurrent}>{stateLabel}</Text>
        <Text dimColor>{"  "}{formatTime(node.enteredAt)}</Text>
      </Box>

      {/* Reason (for non-initial states) */}
      {node.reason && (
        <Box>
          <Text dimColor>{gutter}</Text>
          <Text dimColor>{node.reason}</Text>
        </Box>
      )}

      {/* Runs */}
      {node.runs.length > 5 && (
        <Box>
          <Text dimColor>{gutter}</Text>
          <RunSummary runs={node.runs} />
        </Box>
      )}
      {node.runs.map((run, ri) => (
        <Box key={`run-${run.id}`} flexDirection="column">
          <Box>
            <Text dimColor>{gutter}</Text>
            <RunLine run={run} index={runOffset + ri} gutter={gutter} />
          </Box>
          {run.id === activeRunId && plan && plan.length > 0 && (
            <Box>
              <Text dimColor>{gutter}</Text>
              <PlanSteps plan={plan} />
            </Box>
          )}
        </Box>
      ))}

      {/* Side-trips */}
      {node.sideTrips.length > 0 && (
        <Box flexDirection="column">
          {node.sideTrips.map((trip, ti) => {
            // Count runs before this side-trip for numbering
            const priorSideTripRuns = node.sideTrips.slice(0, ti).reduce((acc, st) => acc + st.runs.length, 0);
            const tripRunOffset = runOffset + node.runs.length + priorSideTripRuns;
            return (
              <SideTripBlock
                key={`trip-${ti}`}
                trip={trip}
                runOffset={tripRunOffset}
                isLast={ti === node.sideTrips.length - 1}
              />
            );
          })}
        </Box>
      )}

      {/* Connector to next node */}
      {!isLast && (
        <Box><Text dimColor>{" \u2502"}</Text></Box>
      )}
    </Box>
  );
}

// ─── Main component ──────────────────────────────────────────────

export function StateHistoryView({ history, plan, activeRunId }: StateHistoryViewProps): React.JSX.Element {
  if (history.length === 0) {
    return (
      <Box>
        <Text dimColor>No state history available.</Text>
      </Box>
    );
  }

  // Compute global run numbering (sequential across all nodes)
  let runCounter = 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      {history.map((node, i) => {
        const offset = runCounter;
        runCounter += node.runs.length + node.sideTrips.reduce((acc, st) => acc + st.runs.length, 0);
        return (
          <MainPathNode
            key={`node-${i}`}
            node={node}
            isLast={i === history.length - 1}
            runOffset={offset}
            plan={plan}
            activeRunId={activeRunId}
          />
        );
      })}
    </Box>
  );
}
