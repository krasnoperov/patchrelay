import { Box, Text } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TimelineRowProps {
  entry: TimelineEntry;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

const CHECK_SYMBOLS: Record<string, string> = {
  passed: "\u2713",
  failed: "\u2717",
  pending: "\u25cf",
};

const CHECK_COLORS: Record<string, string> = {
  passed: "green",
  failed: "red",
  pending: "yellow",
};

function FeedRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const feed = entry.feed!;
  const statusLabel = feed.status ?? feed.feedKind;
  return (
    <Box gap={1}>
      <Text dimColor>{formatTime(entry.at)}</Text>
      <Text color="cyan">{statusLabel.padEnd(16)}</Text>
      <Text>{feed.summary}</Text>
    </Box>
  );
}

function RunStartRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const run = entry.run!;
  return (
    <Box gap={1}>
      <Text dimColor>{formatTime(entry.at)}</Text>
      <Text bold color="yellow">{run.runType.padEnd(16)}</Text>
      <Text bold>run started</Text>
    </Box>
  );
}

function RunEndRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const run = entry.run!;
  const color = run.status === "completed" ? "green" : "red";
  const duration = run.endedAt ? formatDuration(run.startedAt, run.endedAt) : "";
  return (
    <Box gap={1}>
      <Text dimColor>{formatTime(entry.at)}</Text>
      <Text bold color={color}>{run.runType.padEnd(16)}</Text>
      <Text bold color={color}>{run.status}</Text>
      {duration ? <Text dimColor>({duration})</Text> : null}
    </Box>
  );
}

function ItemRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const item = entry.item!;
  return (
    <Box paddingLeft={2}>
      <ItemLine item={item} isLast={false} />
    </Box>
  );
}

function CIChecksRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const ci = entry.ciChecks!;
  return (
    <Box gap={1}>
      <Text dimColor>{formatTime(entry.at)}</Text>
      <Text color={CHECK_COLORS[ci.overall] ?? "white"}>{"ci_checks".padEnd(16)}</Text>
      {ci.checks.map((check, i) => (
        <Text key={`check-${i}`}>
          <Text color={CHECK_COLORS[check.status] ?? "white"}>{CHECK_SYMBOLS[check.status] ?? " "}</Text>
          <Text dimColor> {check.name}  </Text>
        </Text>
      ))}
    </Box>
  );
}

export function TimelineRow({ entry }: TimelineRowProps): React.JSX.Element {
  switch (entry.kind) {
    case "feed":
      return <FeedRow entry={entry} />;
    case "run-start":
      return <RunStartRow entry={entry} />;
    case "run-end":
      return <RunEndRow entry={entry} />;
    case "item":
      return <ItemRow entry={entry} />;
    case "ci-checks":
      return <CIChecksRow entry={entry} />;
  }
}
