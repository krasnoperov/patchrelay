import { Box, Text } from "ink";
import type { VisualizationNode } from "./state-visualization.ts";

interface EntryStateGraphProps {
  main: VisualizationNode[];
  exits: VisualizationNode[];
}

export function EntryStateGraph({ main, exits }: EntryStateGraphProps): React.JSX.Element {
  const visibleExits = exits.filter((n) => n.status !== "upcoming");

  return (
    <Box marginTop={1} gap={0}>
      {main.map((node, i) => {
        const dot = node.status === "upcoming" ? "\u25cb" : "\u25cf"; // ○ or ●
        const color = node.status === "current" ? "cyan"
          : node.status === "visited" ? "green"
            : "gray";
        return (
          <Box key={node.state} gap={0}>
            {i > 0 && <Text dimColor> \u2192 </Text>}
            <Text color={color} bold={node.status === "current"}>{dot}</Text>
            <Text color={color} bold={node.status === "current"}>{` ${node.label}`}</Text>
          </Box>
        );
      })}
      {visibleExits.map((node) => (
        <Box key={node.state} gap={0}>
          <Text dimColor>{"  "}</Text>
          <Text color="red">{`\u25cf ${node.label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
