import { Box, Text } from "ink";
import type { TimelineMode } from "./timeline-presentation.ts";
import type { TimelineDisplayRow, TimelineRunDetail } from "./timeline-presentation.ts";
import { ItemLine } from "./ItemLine.tsx";

interface TimelineRowProps {
  entry: TimelineDisplayRow;
  mode: TimelineMode;
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

function verboseItemLabel(type: string): string {
  switch (type) {
    case "agentMessage":
      return "message";
    case "commandExecution":
      return "command";
    case "fileChange":
      return "files";
    case "mcpToolCall":
    case "dynamicToolCall":
      return "tool";
    case "userMessage":
      return "you";
    case "plan":
      return "plan";
    case "reasoning":
      return "reasoning";
    default:
      return type;
  }
}

function FeedRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "feed" }> }): React.JSX.Element {
  const label = entry.feed.status ?? entry.feed.feedKind;
  const repeatSuffix = entry.repeatCount && entry.repeatCount > 1 ? ` ×${entry.repeatCount}` : "";
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{formatTime(entry.at)} </Text>
        <Text color="cyan" bold>{label.padEnd(12)}</Text>
      </Box>
      <Box paddingLeft={6}>
        <Text wrap="wrap">{entry.feed.summary}{repeatSuffix}</Text>
      </Box>
    </Box>
  );
}

function RunRow({
  entry,
  mode,
}: {
  entry: Extract<TimelineDisplayRow, { kind: "run" }>;
  mode: TimelineMode;
}): React.JSX.Element {
  const run = entry.run;
  const color = runStatusColor(run.status);
  const duration = run.endedAt ? formatDuration(run.startedAt, run.endedAt) : undefined;
  const showVerboseItems = mode === "verbose" && entry.items.length > 0;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{formatTime(entry.at)} </Text>
        <Text bold color="yellow">{(RUN_LABELS[run.runType] ?? run.runType).padEnd(12)}</Text>
        <Text bold color={color}> {runStatusLabel(run.status)}</Text>
        {duration ? <Text dimColor>{` ${duration}`}</Text> : null}
      </Box>
      {entry.details.length > 0 && <Text> </Text>}
      {entry.details.map((detail, index) => (
        <Box key={`${entry.id}-detail-${index}`} paddingLeft={6} marginBottom={index === entry.details.length - 1 ? 0 : 1}>
          <Text wrap="wrap" {...(detailColor(detail) ? { color: detailColor(detail)! } : {})} bold={detail.tone === "message"}>
            {detailPrefix(detail)}{detail.text}
          </Text>
        </Box>
      ))}
      {showVerboseItems && <Text> </Text>}
      {showVerboseItems && entry.items.map((itemEntry, index) => (
        <Box key={`${entry.id}-item-${index}`} flexDirection="column" paddingLeft={6} marginBottom={index === entry.items.length - 1 ? 0 : 1}>
          <Box marginBottom={1}>
            <Text dimColor>{formatTime(itemEntry.at)} </Text>
            <Text dimColor>{verboseItemLabel(itemEntry.item.type)}</Text>
          </Box>
          <Box paddingLeft={2}>
            <ItemLine item={itemEntry.item} />
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function ItemRow({
  entry,
  mode,
}: {
  entry: Extract<TimelineDisplayRow, { kind: "item" }>;
  mode: TimelineMode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingLeft={6} marginBottom={mode === "verbose" ? 1 : 0}>
      <Box marginBottom={1}>
        <Text dimColor>{formatTime(entry.at)} </Text>
        <Text dimColor>{entry.item.type}</Text>
      </Box>
      <Box paddingLeft={2}>
        <ItemLine item={entry.item} />
      </Box>
    </Box>
  );
}

function CIChecksRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "ci-checks" }> }): React.JSX.Element {
  const ci = entry.ciChecks;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text dimColor>{formatTime(entry.at)} </Text>
        <Text color={CHECK_COLORS[ci.overall] ?? "white"} bold>{"checks".padEnd(12)}</Text>
      </Box>
      <Box paddingLeft={6} gap={2} flexWrap="wrap">
        {ci.checks.map((check, i) => (
          <Text key={`c-${i}`}>
            <Text color={CHECK_COLORS[check.status] ?? "white"}>{CHECK_SYMBOLS[check.status] ?? " "}</Text>
            <Text dimColor>{check.name}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export function TimelineRow({ entry, mode }: TimelineRowProps): React.JSX.Element {
  switch (entry.kind) {
    case "feed":
      return <FeedRow entry={entry} />;
    case "run":
      return <RunRow entry={entry} mode={mode} />;
    case "item":
      return <ItemRow entry={entry} mode={mode} />;
    case "ci-checks":
      return <CIChecksRow entry={entry} />;
  }
}
