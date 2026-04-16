import { Box, Text } from "ink";
import { hasOpenPr } from "../../pr-state.ts";
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
  compact?: boolean;
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
  compact = false,
}: StatusBarProps): React.JSX.Element {
  const showing = filter === "all" ? `${totalCount} issues` : `${issues.length}/${totalCount} issues`;
  const aggregateSource = filter === "all" ? allIssues : issues;
  const agg = computeAggregates(aggregateSource);
  const withPr = aggregateSource.filter((i) => hasOpenPr(i.prNumber, i.prState)).length;
  const waitingInput = aggregateSource.filter((i) => i.sessionState === "waiting_input" || i.factoryState === "awaiting_input").length;
  const intervention = aggregateSource.filter((i) => i.sessionState === "failed" || i.factoryState === "failed" || i.factoryState === "escalated").length;
  const running = aggregateSource.filter((i) => i.sessionState === "running").length;
  const idle = aggregateSource.filter((i) => i.sessionState === "idle").length;
  if (compact) {
    const compactParts = [
      withPr > 0 ? `p${withPr}` : null,
      running > 0 ? `r${running}` : null,
      waitingInput > 0 ? `w${waitingInput}` : null,
      intervention > 0 ? `x${intervention}` : null,
      agg.blocked > 0 ? `b${agg.blocked}` : null,
      agg.ready > 0 ? `q${agg.ready}` : null,
      agg.failed > 0 ? `f${agg.failed}` : null,
      agg.done > 0 ? `d${agg.done}` : null,
      frozen ? "frozen" : null,
    ].filter(Boolean) as string[];

    return (
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold>patchrelay</Text>
          <Text dimColor>{showing}</Text>
          <Text dimColor>[{FILTER_LABELS[filter][0]}]</Text>
          {compactParts.length > 0 ? <Text dimColor>{compactParts.join(" ")}</Text> : null}
        </Box>
        <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
      </Box>
    );
  }

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
        {intervention > 0 && <Text color="red">{intervention} needs help</Text>}
        {agg.done > 0 && <Text color="green">{agg.done} done</Text>}
        {agg.failed > 0 && <Text color="red">{agg.failed} failed</Text>}
        {frozen && <Text color="magenta">frozen</Text>}
      </Box>
      <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
    </Box>
  );
}
