import { Box, Text } from "ink";
import type { TimelineDisplayRow, TimelineRunDetail } from "./timeline-presentation.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TimelineRowProps {
  entry: TimelineDisplayRow;
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${minutes}m ${String(s).padStart(2, "0")}s`;
}

const CHECK_SYMBOLS: Record<string, string> = { passed: "\u2713", failed: "\u2717", pending: "\u25cf" };
const CHECK_COLORS: Record<string, string> = { passed: "green", failed: "red", pending: "yellow" };

const RUN_LABELS: Record<string, string> = {
  implementation: "implement",
  ci_repair: "ci fix",
  review_fix: "review fix",
  branch_upkeep: "branch upkeep",
  queue_repair: "merge fix",
};

function runDotColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "released") return "magenta";
  if (status === "running") return "yellow";
  return "white";
}

function detailColor(detail: TimelineRunDetail): string | undefined {
  if (detail.tone === "command") return "white";
  if (detail.tone === "user") return "yellow";
  return undefined;
}

function detailPrefix(detail: TimelineRunDetail): string {
  if (detail.tone === "command") return "$ ";
  return "";
}

function FeedRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "feed" }> }): React.JSX.Element {
  const label = entry.feed.status ?? entry.feed.feedKind;
  const repeatSuffix = entry.repeatCount && entry.repeatCount > 1 ? ` \u00d7${entry.repeatCount}` : "";
  return (
    <Box marginTop={1}>
      <Text color="cyan">{"\u25cf"}</Text>
      <Text color="cyan">{` ${label}`}</Text>
      <Text dimColor>{`  ${entry.feed.summary}${repeatSuffix}`}</Text>
    </Box>
  );
}

function RunRow({
  entry,
}: {
  entry: Extract<TimelineDisplayRow, { kind: "run" }>;
}): React.JSX.Element {
  const run = entry.run;
  const dotColor = runDotColor(run.status);
  const duration = run.endedAt ? formatDuration(run.startedAt, run.endedAt) : undefined;
  const showItems = entry.items.length > 0;
  const showDetails = !showItems && entry.details.length > 0;

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={dotColor}>{"\u25cf"}</Text>
        <Text bold color="yellow">{` ${RUN_LABELS[run.runType] ?? run.runType}`}</Text>
        <Text bold color={dotColor}>{`  ${run.status}`}</Text>
        {duration ? <Text dimColor>{`  ${duration}`}</Text> : null}
      </Box>
      {showItems && entry.items.map((itemEntry, index) => (
        <Box key={`${entry.id}-item-${index}`} paddingLeft={2}>
          <ItemLine item={itemEntry.item} />
        </Box>
      ))}
      {showDetails && entry.details.map((detail, index) => (
        <Box key={`${entry.id}-detail-${index}`} paddingLeft={2}>
          <Text wrap="wrap" {...(detailColor(detail) ? { color: detailColor(detail)! } : { dimColor: true })} bold={detail.tone === "message"}>
            {detailPrefix(detail)}{detail.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function ItemRow({
  entry,
}: {
  entry: Extract<TimelineDisplayRow, { kind: "item" }>;
}): React.JSX.Element {
  return (
    <Box paddingLeft={2}>
      <ItemLine item={entry.item} />
    </Box>
  );
}

function CIChecksRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "ci-checks" }> }): React.JSX.Element {
  const ci = entry.ciChecks;
  const dotColor = CHECK_COLORS[ci.overall] ?? "white";
  return (
    <Box marginTop={1}>
      <Text color={dotColor}>{"\u25cf"}</Text>
      <Text color={dotColor} bold>{` checks`}</Text>
      <Text>{`  `}</Text>
      {ci.checks.map((check, i) => (
        <Text key={`c-${i}`}>
          {i > 0 ? <Text>{`  `}</Text> : null}
          <Text color={CHECK_COLORS[check.status] ?? "white"}>{CHECK_SYMBOLS[check.status] ?? " "}</Text>
          <Text dimColor>{` ${check.name}`}</Text>
        </Text>
      ))}
    </Box>
  );
}

export function TimelineRow({ entry }: { entry: TimelineDisplayRow }): React.JSX.Element {
  switch (entry.kind) {
    case "feed":
      return <FeedRow entry={entry} />;
    case "run":
      return <RunRow entry={entry} />;
    case "item":
      return <ItemRow entry={entry} />;
    case "ci-checks":
      return <CIChecksRow entry={entry} />;
  }
}
