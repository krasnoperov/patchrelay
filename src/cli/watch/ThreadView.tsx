import { Box, Text } from "ink";
import type { WatchThread } from "./watch-state.ts";
import { TurnSection } from "./TurnSection.tsx";

interface ThreadViewProps {
  thread: WatchThread;
}

function planStepSymbol(status: string): string {
  if (status === "completed") return "\u2713";
  if (status === "inProgress") return "\u25b8";
  return " ";
}

function planStepColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "inProgress") return "yellow";
  return "white";
}

export function ThreadView({ thread }: ThreadViewProps): React.JSX.Element {
  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text dimColor>Thread: {thread.threadId.slice(0, 16)}</Text>
        <Text dimColor>Status: {thread.status}</Text>
        <Text dimColor>Turns: {thread.turns.length}</Text>
      </Box>

      {thread.plan && thread.plan.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Plan:</Text>
          {thread.plan.map((entry, i) => (
            <Box key={`plan-${i}`} gap={1}>
              <Text color={planStepColor(entry.status)}>[{planStepSymbol(entry.status)}]</Text>
              <Text>{entry.step}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Box flexDirection="column" marginTop={1}>
        {thread.turns.map((turn, i) => (
          <TurnSection key={turn.id} turn={turn} index={i} />
        ))}
      </Box>
    </Box>
  );
}
