import { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import type { QueueBlockState, QueueEntry, QueueEventSummary } from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";
import { ciStatusIcon, formatEventSummary, humanStatus, nextStepLabel, progressBar, queueProgress, relativeTime, specChainLabel, statusColor, summarizeQueueBlock, truncate } from "./format.ts";

interface QueueListViewProps {
  entries: QueueEntry[];
  selectedEntryId: string | null;
  recentEvents: QueueEventSummary[];
  headEntryId: string | null;
  queueBlock: QueueBlockState | null;
}

const ENTRY_ROW_HEIGHT = 2;
const CHROME_ROWS = 13;

function QueueRow({
  entry,
  selected,
  infoWidth,
  isHead,
  queueBlock,
  allEntries,
}: {
  entry: QueueEntry;
  selected: boolean;
  infoWidth: number;
  isHead: boolean;
  queueBlock: QueueBlockState | null;
  allEntries: QueueEntry[];
}): React.JSX.Element {
  const isTerminal = TERMINAL_STATUSES.includes(entry.status);

  // Terminal entries render as a single compact dimmed line.
  if (isTerminal) {
    return (
      <Box>
        <Text dimColor>  </Text>
        <Text color={entry.status === "merged" ? "green" : "red"}>
          {entry.status === "merged" ? "\u2713" : "\u2717"}
        </Text>
        <Text dimColor>{` #${entry.prNumber}`}</Text>
        {entry.issueKey ? <Text dimColor>{` ${entry.issueKey}`}</Text> : null}
        <Text dimColor>{`  ${humanStatus(entry.status)}  ${relativeTime(entry.updatedAt)}`}</Text>
      </Box>
    );
  }

  const retryText = `${entry.retryAttempts}/${entry.maxRetries}`;
  const ciText = entry.ciRetries > 0 ? `CI retries ${entry.ciRetries}` : null;
  const blockedOnMain = isHead && queueBlock?.reason === "main_broken" && queueBlock.headPrNumber === entry.prNumber;
  const renderedStatus = blockedOnMain ? "blocked by broken main" : humanStatus(entry.status, entry);
  const renderedColor = blockedOnMain
    ? "red"
    : entry.status === "preparing_head" && entry.lastFailedBaseSha ? "yellow"
      : statusColor(entry.status);
  const progress = queueProgress(entry.status);
  const specLabel = entry.specBranch
    ? specChainLabel(entry, allEntries)
    : truncate(entry.branch, Math.max(12, infoWidth - 34));
  const nextStep = blockedOnMain
    ? summarizeQueueBlock(queueBlock) ?? "waiting for main to recover"
    : nextStepLabel(entry.status, entry);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={selected ? "cyan" : "gray"}>{selected ? "\u203a" : " "}</Text>
        <Text color={blockedOnMain ? "red" : isHead ? "green" : "gray"}>{blockedOnMain ? "!" : isHead ? "#" : " "}</Text>
        <Text bold>{` #${entry.prNumber}`}</Text>
        {entry.issueKey ? <Text>{` ${entry.issueKey}`}</Text> : null}
        <Text dimColor>{`  pos ${entry.position}`}</Text>
        <Text dimColor>{`  ${relativeTime(entry.updatedAt)}`}</Text>
        <Text>{`  `}</Text>
        <Text color={renderedColor}>{renderedStatus}</Text>
      </Box>
      <Box paddingLeft={2} gap={1}>
        <Text dimColor>{progressBar(progress.current, progress.total, 8)}</Text>
        <Text dimColor>{specLabel}</Text>
        <Text dimColor>|</Text>
        <Text dimColor>{nextStep}</Text>
        <Text dimColor>{` | retry ${retryText}`}</Text>
        {ciText ? (
          <>
            <Text dimColor>|</Text>
            <Text dimColor>{ciText}</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}

export function QueueListView({
  entries,
  selectedEntryId,
  recentEvents,
  headEntryId,
  queueBlock,
}: QueueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 100;
  const infoWidth = Math.max(32, cols - 4);
  const eventRows = Math.min(8, Math.max(4, rows - (entries.length * ENTRY_ROW_HEIGHT) - CHROME_ROWS));
  const displayedEvents = useMemo(() => recentEvents.slice(-eventRows), [eventRows, recentEvents]);
  const queueBlockLabel = summarizeQueueBlock(queueBlock);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Spec chain: main ─ #A ✓ ─ #B ● ─ #C ○ */}
      {entries.length > 0 && (
        <Box marginBottom={1} gap={0}>
          <Text dimColor>main</Text>
          {entries.map((entry) => {
            const ci = ciStatusIcon(entry);
            return (
              <Box key={entry.id} gap={0}>
                <Text dimColor>{" \u2500 "}</Text>
                <Text bold>#{entry.prNumber}</Text>
                <Text color={ci.color}>{` ${ci.icon}`}</Text>
              </Box>
            );
          })}
        </Box>
      )}
      {queueBlock && (
        <Box marginBottom={1} flexDirection="column">
          <Text color="yellow">
            Queue paused: {queueBlockLabel ?? "main is unhealthy"}{queueBlock.baseSha ? ` at ${truncate(queueBlock.baseSha, 10)}` : ""}.
          </Text>
          <Text dimColor>Head PR #{queueBlock.headPrNumber ?? "?"} will resume automatically once main recovers.</Text>
        </Box>
      )}
      {entries.length === 0 ? (
        <Text dimColor>No queue entries in this filter.</Text>
      ) : (
        entries.map((entry) => (
          <QueueRow
            key={entry.id}
            entry={entry}
            selected={entry.id === selectedEntryId}
            infoWidth={infoWidth}
            isHead={entry.id === headEntryId}
            queueBlock={queueBlock}
            allEntries={entries}
          />
        ))
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent Events</Text>
        {displayedEvents.length === 0 ? (
          <Text dimColor>No queue events yet.</Text>
        ) : (
          displayedEvents.map((event) => (
            <Box key={event.id ?? `${event.entryId}-${event.at}`} gap={1}>
              <Text dimColor>{relativeTime(event.at).padStart(4, " ")}</Text>
              <Text>{formatEventSummary(event)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
