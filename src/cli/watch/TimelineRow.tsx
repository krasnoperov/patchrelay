import { Box, Text } from "ink";
import type { TimelineMode } from "./timeline-presentation.ts";
import type { TimelineDisplayRow, TimelineRunDetail } from "./timeline-presentation.ts";
import { ItemLine } from "./ItemLine.tsx";
import { relativeTime } from "./format-utils.ts";

interface TimelineRowProps {
  entry: TimelineDisplayRow;
  mode: TimelineMode;
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
    case "agentMessage": return "message";
    case "commandExecution": return "command";
    case "fileChange": return "files";
    case "mcpToolCall":
    case "dynamicToolCall": return "tool";
    case "userMessage": return "you";
    case "plan": return "plan";
    case "reasoning": return "reasoning";
    default: return type;
  }
}

function TimeStamp({ at }: { at: string }): React.JSX.Element {
  return <Text dimColor>{relativeTime(at).padStart(4)}</Text>;
}

function FeedRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "feed" }> }): React.JSX.Element {
  const label = entry.feed.status ?? entry.feed.feedKind;
  const repeatSuffix = entry.repeatCount && entry.repeatCount > 1 ? ` \u00d7${entry.repeatCount}` : "";
  return (
    <Box>
      <TimeStamp at={entry.at} />
      <Text color="cyan">{`  ${label}`}</Text>
      <Text dimColor>{`  ${entry.feed.summary}${repeatSuffix}`}</Text>
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

  // Item counts for metadata
  const msgs = entry.items.filter((i) => i.item.type === "agentMessage").length;
  const cmds = entry.items.filter((i) => i.item.type === "commandExecution").length;
  const files = entry.items.filter((i) => i.item.type === "fileChange").length;
  const tools = entry.items.filter((i) => i.item.type === "mcpToolCall" || i.item.type === "dynamicToolCall").length;
  const meta: string[] = [];
  if (msgs > 0) meta.push(`${msgs} msg`);
  if (cmds > 0) meta.push(`${cmds} cmd`);
  if (files > 0) meta.push(`${files} file`);
  if (tools > 0) meta.push(`${tools} tool`);
  return (
    <Box flexDirection="column">
      <Box>
        <TimeStamp at={entry.at} />
        <Text bold color="yellow">{`  ${RUN_LABELS[run.runType] ?? run.runType}`}</Text>
        <Text bold color={color}>{`  ${run.status}`}</Text>
        {duration ? <Text dimColor>{`  ${duration}`}</Text> : null}
        {meta.length > 0 ? <Text dimColor>{`  ${meta.join("  ")}`}</Text> : null}
      </Box>
      {entry.details.map((detail, index) => (
        <Box key={`${entry.id}-detail-${index}`} paddingLeft={4}>
          <Text wrap="wrap" {...(detailColor(detail) ? { color: detailColor(detail)! } : { dimColor: true })} bold={detail.tone === "message"}>
            {detailPrefix(detail)}{detail.text}
          </Text>
        </Box>
      ))}
      {showVerboseItems && entry.items.map((itemEntry, index) => (
        <Box key={`${entry.id}-item-${index}`} flexDirection="column" paddingLeft={4}>
          <Box>
            <TimeStamp at={itemEntry.at} />
            <Text dimColor>{`  ${verboseItemLabel(itemEntry.item.type)}`}</Text>
          </Box>
          <Box paddingLeft={6}>
            <ItemLine item={itemEntry.item} />
          </Box>
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
    <Box flexDirection="column" paddingLeft={4}>
      <Box>
        <TimeStamp at={entry.at} />
        <Text dimColor>{`  ${verboseItemLabel(entry.item.type)}`}</Text>
      </Box>
      <Box paddingLeft={6}>
        <ItemLine item={entry.item} />
      </Box>
    </Box>
  );
}

function CIChecksRow({ entry }: { entry: Extract<TimelineDisplayRow, { kind: "ci-checks" }> }): React.JSX.Element {
  const ci = entry.ciChecks;
  return (
    <Box>
      <TimeStamp at={entry.at} />
      <Text color={CHECK_COLORS[ci.overall] ?? "white"} bold>{`  checks`}</Text>
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

export function TimelineRow({ entry, mode }: TimelineRowProps): React.JSX.Element {
  switch (entry.kind) {
    case "feed":
      return <FeedRow entry={entry} />;
    case "run":
      return <RunRow entry={entry} mode={mode} />;
    case "item":
      return <ItemRow entry={entry} />;
    case "ci-checks":
      return <CIChecksRow entry={entry} />;
  }
}
