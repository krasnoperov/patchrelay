import { Box, Text } from "ink";
import type { WatchTurn } from "./watch-state.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TurnSectionProps {
  turn: WatchTurn;
  index: number;
}

function turnStatusColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed" || status === "interrupted") return "red";
  if (status === "inProgress") return "yellow";
  return "white";
}

export function TurnSection({ turn, index }: TurnSectionProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>Turn #{index + 1}</Text>
        <Text color={turnStatusColor(turn.status)}>{turn.status}</Text>
        <Text dimColor>({turn.items.length} items)</Text>
      </Box>
      {turn.items.map((item, i) => (
        <ItemLine
          key={item.id}
          item={item}
          isLast={i === turn.items.length - 1}
        />
      ))}
    </Box>
  );
}
