import { Box, Text } from "ink";
import type { VisualizationNode, VisualizationNodeStatus } from "./state-visualization.ts";

interface FactoryStateGraphProps {
  main: VisualizationNode[];
  prLoops: VisualizationNode[];
  queueLoop: VisualizationNode[];
  exits: VisualizationNode[];
}

function statusColor(status: VisualizationNodeStatus): string {
  switch (status) {
    case "current":
      return "cyan";
    case "visited":
      return "green";
    case "upcoming":
      return "gray";
  }
}

function statusPrefix(status: VisualizationNodeStatus): string {
  switch (status) {
    case "current":
      return "*";
    case "visited":
      return "+";
    case "upcoming":
      return " ";
  }
}

function NodePill({ node }: { node: VisualizationNode }): React.JSX.Element {
  return (
    <Text color={statusColor(node.status)} bold={node.status === "current"}>
      [{statusPrefix(node.status)} {node.label}]
    </Text>
  );
}

function NodeRow({
  label,
  nodes,
  connector = " -> ",
}: {
  label: string;
  nodes: VisualizationNode[];
  connector?: string;
}): React.JSX.Element {
  return (
    <Box>
      <Text dimColor>{label.padEnd(11, " ")}</Text>
      {nodes.map((node, index) => (
        <Box key={node.state}>
          {index > 0 && <Text dimColor>{connector}</Text>}
          <NodePill node={node} />
        </Box>
      ))}
    </Box>
  );
}

export function FactoryStateGraph({
  main,
  prLoops,
  queueLoop,
  exits,
}: FactoryStateGraphProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>State Graph</Text>
      <NodeRow label="main" nodes={main} />
      <NodeRow label="pr loops" nodes={prLoops} connector="   " />
      <NodeRow label="queue loop" nodes={queueLoop} connector="   " />
      <NodeRow label="exits" nodes={exits} connector="   " />
    </Box>
  );
}
