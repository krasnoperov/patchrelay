import { Box, Text } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TimelineRowProps {
  entry: TimelineEntry;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(startedAt: string, endedAt: string): string {
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${minutes}m${s > 0 ? ` ${s}s` : ""}`;
}

const CHECK_SYMBOLS: Record<string, string> = { passed: "\u2713", failed: "\u2717", pending: "\u25cf" };
const CHECK_COLORS: Record<string, string> = { passed: "green", failed: "red", pending: "yellow" };

const RUN_LABELS: Record<string, string> = {
  implementation: "implement",
  ci_repair: "ci fix",
  review_fix: "review fix",
  queue_repair: "merge fix",
};

function FeedRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const feed = entry.feed!;
  const label = feed.status ?? feed.feedKind;
  return (
    <Box>
      <Text dimColor>{formatTime(entry.at)} </Text>
      <Text color="cyan">{label.padEnd(14)}</Text>
      <Text> {feed.summary}</Text>
    </Box>
  );
}

function RunStartRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const run = entry.run!;
  return (
    <Box>
      <Text dimColor>{formatTime(entry.at)} </Text>
      <Text bold color="yellow">{(RUN_LABELS[run.runType] ?? run.runType).padEnd(14)}</Text>
      <Text bold> started</Text>
    </Box>
  );
}

function RunEndRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const run = entry.run!;
  const color = run.status === "completed" ? "green" : "red";
  const dur = run.endedAt ? ` ${formatDuration(run.startedAt, run.endedAt)}` : "";
  return (
    <Box>
      <Text dimColor>{formatTime(entry.at)} </Text>
      <Text bold color={color}>{(RUN_LABELS[run.runType] ?? run.runType).padEnd(14)}</Text>
      <Text bold color={color}> {run.status}</Text>
      {dur ? <Text dimColor>{dur}</Text> : null}
    </Box>
  );
}

function ItemRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  return (
    <Box paddingLeft={2}>
      <ItemLine item={entry.item!} isLast={false} />
    </Box>
  );
}

function CIChecksRow({ entry }: { entry: TimelineEntry }): React.JSX.Element {
  const ci = entry.ciChecks!;
  return (
    <Box>
      <Text dimColor>{formatTime(entry.at)} </Text>
      <Text color={CHECK_COLORS[ci.overall] ?? "white"}>{"checks".padEnd(14)}</Text>
      <Text> </Text>
      {ci.checks.map((check, i) => (
        <Text key={`c-${i}`}>
          <Text color={CHECK_COLORS[check.status] ?? "white"}>{CHECK_SYMBOLS[check.status] ?? " "}</Text>
          <Text dimColor>{check.name} </Text>
        </Text>
      ))}
    </Box>
  );
}

export function TimelineRow({ entry }: TimelineRowProps): React.JSX.Element {
  switch (entry.kind) {
    case "feed": return <FeedRow entry={entry} />;
    case "run-start": return <RunStartRow entry={entry} />;
    case "run-end": return <RunEndRow entry={entry} />;
    case "item": return <ItemRow entry={entry} />;
    case "ci-checks": return <CIChecksRow entry={entry} />;
  }
}
