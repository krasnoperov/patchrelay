import { Box, Text } from "ink";
import type { TimelineDisplayRow, TimelineRunDetail } from "./timeline-presentation.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TimelineRowProps {
  entry: TimelineDisplayRow;
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
  return `${minutes}m ${String(s).padStart(2, "0")}s`;
}

const CHECK_SYMBOLS: Record<string, string> = { passed: "\u2713", failed: "\u2717", pending: "\u25cf" };
const CHECK_COLORS: Record<string, string> = { passed: "green", failed: "red", pending: "yellow" };

const RUN_LABELS: Record<string, string> = {
  implementation: "implement",
  ci_repair: "ci fix",
  review_fix: "review fix",
  queue_repair: "merge fix",
};

function runStatusColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "released") return "magenta";
  if (status === "running") return "yellow";
  return "white";
}

function runStatusLabel(status: string): string {
  if (status === "running") return "running";
  if (status === "released") return "released";
  return status;
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
  return (
    <Box>
      <Text dimColor>{formatTime(entry.at)} </Text>
      <Text color="cyan">{label.padEnd(12)}</Text>
      <Text> {entry.feed.summary}</Text>
    </Box>
  );
}

function RunRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "run" }> }): React.JSX.Element {
  const run = entry.run;
  const color = runStatusColor(run.status);
  const duration = run.endedAt ? formatDuration(run.startedAt, run.endedAt) : undefined;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>{formatTime(entry.at)} </Text>
        <Text bold color="yellow">{(RUN_LABELS[run.runType] ?? run.runType).padEnd(12)}</Text>
        <Text color={color}> {runStatusLabel(run.status)}</Text>
        {duration ? <Text dimColor>{` ${duration}`}</Text> : null}
      </Box>
      {entry.details.map((detail, index) => (
        <Box key={`${entry.id}-detail-${index}`} paddingLeft={6}>
          <Text dimColor>  </Text>
          <Text wrap="wrap" {...(detailColor(detail) ? { color: detailColor(detail)! } : {})}>
            {detailPrefix(detail)}{detail.text}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function ItemRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "item" }> }): React.JSX.Element {
  return (
    <Box paddingLeft={6}>
      <ItemLine item={entry.item} />
    </Box>
  );
}

function CIChecksRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "ci-checks" }> }): React.JSX.Element {
  const ci = entry.ciChecks;
  return (
    <Box>
      <Text dimColor>{formatTime(entry.at)} </Text>
      <Text color={CHECK_COLORS[ci.overall] ?? "white"}>{"checks".padEnd(12)}</Text>
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
