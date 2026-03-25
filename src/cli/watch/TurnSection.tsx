import { Box, Text } from "ink";
import type { WatchTurn } from "./watch-state.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TurnSectionProps {
  turn: WatchTurn;
  index: number;
  follow: boolean;
}

function turnStatusColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed" || status === "interrupted") return "red";
  if (status === "inProgress") return "yellow";
  return "white";
}

const FOLLOW_TAIL_SIZE = 8;

export function TurnSection({ turn, index, follow }: TurnSectionProps): React.JSX.Element {
  const items = follow && turn.items.length > FOLLOW_TAIL_SIZE
    ? turn.items.slice(-FOLLOW_TAIL_SIZE)
    : turn.items;
  const skipped = turn.items.length - items.length;

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>Turn #{index + 1}</Text>
        <Text color={turnStatusColor(turn.status)}>{turn.status}</Text>
        <Text dimColor>({turn.items.length} items)</Text>
      </Box>
      {skipped > 0 && <Text dimColor>  ... {skipped} earlier items</Text>}
      {items.map((item, i) => (
        <ItemLine
          key={item.id}
          item={item}
          isLast={i === items.length - 1}
        />
      ))}
    </Box>
  );
}
