import { Box, Text } from "ink";
import type { WatchFilter, WatchIssue } from "./watch-state.ts";
import { computeAggregates } from "./watch-state.ts";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface StatusBarProps {
  issues: WatchIssue[];
  totalCount: number;
  filter: WatchFilter;
  connected: boolean;
  lastServerMessageAt: number | null;
  allIssues: WatchIssue[];
}

const FILTER_LABELS: Record<WatchFilter, string> = {
  "all": "all",
  "active": "active",
  "non-done": "in progress",
};

export function StatusBar({
  issues,
  totalCount,
  filter,
  connected,
  lastServerMessageAt,
  allIssues,
}: StatusBarProps): React.JSX.Element {
  const showing = filter === "all" ? `${totalCount} issues` : `${issues.length}/${totalCount} issues`;
  const agg = computeAggregates(allIssues);
  return (
    <Box justifyContent="space-between">
      <Box gap={1}>
        <Text bold>{showing}</Text>
        <Text dimColor>[{FILTER_LABELS[filter]}]</Text>
        <Text dimColor>|</Text>
        {agg.active > 0 && <Text color="yellow">{agg.active} active</Text>}
        {agg.done > 0 && <Text color="green">{agg.done} done</Text>}
        {agg.failed > 0 && <Text color="red">{agg.failed} failed</Text>}
      </Box>
      <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
    </Box>
  );
}
