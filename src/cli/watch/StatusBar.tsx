import { Box, Text } from "ink";
import type { WatchIssue } from "./watch-state.ts";

interface StatusBarProps {
  issues: WatchIssue[];
  connected: boolean;
}

export function StatusBar({ issues, connected }: StatusBarProps): React.JSX.Element {
  const active = issues.filter((i) => i.activeRunType).length;
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text bold>{issues.length}</Text>
        <Text> issues tracked</Text>
        {active > 0 && (
          <Text>
            , <Text bold color="green">{active}</Text> active
          </Text>
        )}
      </Text>
      <Text color={connected ? "green" : "red"}>
        {connected ? "● connected" : "○ disconnected"}
      </Text>
    </Box>
  );
}
