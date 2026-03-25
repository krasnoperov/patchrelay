import { Box, Text } from "ink";
import type { WatchFilter, WatchIssue } from "./watch-state.ts";

interface StatusBarProps {
  issues: WatchIssue[];
  totalCount: number;
  filter: WatchFilter;
  connected: boolean;
}

const FILTER_LABELS: Record<WatchFilter, string> = {
  "all": "all",
  "active": "active",
  "non-done": "in progress",
};

export function StatusBar({ issues, totalCount, filter, connected }: StatusBarProps): React.JSX.Element {
  const showing = filter === "all" ? `${totalCount} issues` : `${issues.length}/${totalCount} issues`;
  return (
    <Box justifyContent="space-between">
      <Text>
        <Text bold>{showing}</Text>
        <Text dimColor> [{FILTER_LABELS[filter]}]</Text>
      </Text>
      <Text color={connected ? "green" : "red"}>
        {connected ? "\u25cf connected" : "\u25cb disconnected"}
      </Text>
    </Box>
  );
}
