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
  frozen: boolean;
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
  frozen,
}: StatusBarProps): React.JSX.Element {
  const showing = filter === "all" ? `${totalCount} issues` : `${issues.length}/${totalCount} issues`;
  const aggregateSource = filter === "all" ? allIssues : issues;
  const agg = computeAggregates(aggregateSource);
  const withPr = aggregateSource.filter((i) => i.prNumber !== undefined).length;
  const waitingInput = aggregateSource.filter((i) => i.sessionState === "waiting_input" || i.factoryState === "awaiting_input").length;
  const running = aggregateSource.filter((i) => i.sessionState === "running").length;
  const idle = aggregateSource.filter((i) => i.sessionState === "idle").length;
  return (
    <Box justifyContent="space-between">
      <Box gap={1}>
        <Text bold>{showing}</Text>
        <Text dimColor>[{FILTER_LABELS[filter]}]</Text>
        <Text dimColor>|</Text>
        {running > 0 && <Text color="cyan">{running} running</Text>}
        {idle > 0 && <Text color="blueBright">{idle} idle</Text>}
        {agg.ready > 0 && <Text color="blueBright">{agg.ready} ready</Text>}
        {agg.blocked > 0 && <Text color="yellow">{agg.blocked} blocked</Text>}
        {withPr > 0 && <Text dimColor>{withPr} PRs</Text>}
        {waitingInput > 0 && <Text color="yellow">{waitingInput} needs input</Text>}
        {agg.done > 0 && <Text color="green">{agg.done} done</Text>}
        {agg.failed > 0 && <Text color="red">{agg.failed} failed</Text>}
        {frozen && <Text color="magenta">frozen</Text>}
      </Box>
      <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
    </Box>
  );
}
