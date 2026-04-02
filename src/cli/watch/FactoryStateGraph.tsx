import { Box, Text } from "ink";
import type { VisualizationNode } from "./state-visualization.ts";

interface FactoryStateGraphProps {
  main: VisualizationNode[];
  prLoops: VisualizationNode[];
  queueLoop: VisualizationNode[];
  exits: VisualizationNode[];
}

const STATE_LABELS: Record<string, string> = {
  delegated: "delegated",
  implementing: "implementing",
  pr_open: "PR open",
  awaiting_queue: "merge queue",
  done: "done",
  changes_requested: "review fix",
  repairing_ci: "CI repair",
  repairing_queue: "queue repair",
  awaiting_input: "needs input",
  escalated: "escalated",
  failed: "failed",
};

function displayLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

function NodeRow({ nodes, connector }: { nodes: VisualizationNode[]; connector: string }): React.JSX.Element {
  const visible = nodes.filter((n) => connector === " \u2192 " || n.status !== "upcoming");
  if (visible.length === 0) return <></>;
  return (
    <Box gap={0}>
      {visible.map((node, i) => {
        const dot = node.status === "upcoming" ? "\u25cb" : "\u25cf";
        const color = node.status === "current" ? "cyan"
          : node.status === "visited" ? "green"
            : "gray";
        return (
          <Box key={node.state} gap={0}>
            {i > 0 && <Text dimColor>{connector}</Text>}
            <Text color={color} bold={node.status === "current"}>{dot}</Text>
            <Text color={color} bold={node.status === "current"}>{` ${displayLabel(node.state)}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function FactoryStateGraph({
  main,
  prLoops,
  queueLoop,
  exits,
}: FactoryStateGraphProps): React.JSX.Element {
  const hasLoops = prLoops.some((n) => n.status !== "upcoming") || queueLoop.some((n) => n.status !== "upcoming");
  const hasExits = exits.some((n) => n.status !== "upcoming");
  return (
    <Box flexDirection="column" marginTop={1}>
      <NodeRow nodes={main} connector=" \u2192 " />
      {hasLoops && (
        <Box gap={0} paddingLeft={2}>
          <NodeRow nodes={[...prLoops, ...queueLoop]} connector="  " />
        </Box>
      )}
      {hasExits && (
        <Box gap={0} paddingLeft={2}>
          <NodeRow nodes={exits} connector="  " />
        </Box>
      )}
    </Box>
  );
}
