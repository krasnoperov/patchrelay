import { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import type { QueueBlockState, QueueEntry, QueueEventSummary } from "../types.ts";
import { TERMINAL_STATUSES } from "../types.ts";
import { buildChainEntries } from "./display-filter.ts";
import { ciStatusIcon, formatEventSummary, humanStatus, isPendingMainVerification, nextStepLabel, relativeTime, statusColor, summarizeQueueBlock, truncate } from "./format.ts";

interface QueueListViewProps {
  entries: QueueEntry[];
  allEntries: QueueEntry[];
  selectedEntryId: string | null;
  recentEvents: QueueEventSummary[];
  headEntryId: string | null;
  queueBlock: QueueBlockState | null;
}

const CHROME_ROWS = 13;

function QueueRow({
  entry,
  selected,
  isHead,
  queueBlock,
}: {
  entry: QueueEntry;
  selected: boolean;
  isHead: boolean;
  queueBlock: QueueBlockState | null;
}): React.JSX.Element {
  const isTerminal = TERMINAL_STATUSES.includes(entry.status);

  if (isTerminal) {
    const icon = entry.status === "merged" ? "\u2713" : "\u2717";
    const iconColor = entry.status === "merged" ? "green" : "red";
    return (
      <Box>
        <Text dimColor> </Text>
        <Text dimColor>{` #${entry.prNumber}`}</Text>
        {entry.issueKey ? <Text dimColor>{` ${entry.issueKey}`}</Text> : null}
        <Text dimColor>{`  ${relativeTime(entry.updatedAt).padStart(4)}`}</Text>
        <Text>{`  `}</Text>
        <Text color={iconColor}>{`${icon} ${humanStatus(entry.status)}`}</Text>
      </Box>
    );
  }

  const blockedOnMain = isHead && queueBlock?.reason === "main_broken" && queueBlock.headPrNumber === entry.prNumber;
  const pendingMainVerification = blockedOnMain && isPendingMainVerification(queueBlock);
  const status = blockedOnMain
    ? pendingMainVerification ? "verifying main" : "waiting for main"
    : humanStatus(entry.status, entry);
  const color = blockedOnMain ? (pendingMainVerification ? "yellow" : "red")
    : entry.status === "preparing_head" && entry.lastFailedBaseSha ? "yellow"
      : statusColor(entry.status);
  const nextStep = blockedOnMain
    ? summarizeQueueBlock(queueBlock) ?? "waiting for main checks to settle"
    : nextStepLabel(entry.status, entry);

  // Only show retry counter when retries have actually happened.
  const retryNote = entry.retryAttempts > 0 ? ` \u00b7 retry ${entry.retryAttempts}/${entry.maxRetries}` : "";

  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "\u25b8" : " "}</Text>
      <Text {...(isHead ? { color: "green" } : {})} bold>{` #${entry.prNumber}`}</Text>
      {entry.issueKey ? <Text>{` ${entry.issueKey}`}</Text> : null}
      <Text dimColor>{`  ${relativeTime(entry.updatedAt).padStart(4)}`}</Text>
      <Text>{`  `}</Text>
      <Text color={color}>{status}</Text>
      <Text dimColor>{` \u00b7 ${nextStep}${retryNote}`}</Text>
    </Box>
  );
}

export function QueueListView({
  entries,
  allEntries,
  selectedEntryId,
  recentEvents,
  headEntryId,
  queueBlock,
}: QueueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  // All entries are 1 row now.
  const eventRows = Math.min(8, Math.max(4, rows - entries.length - CHROME_ROWS));
  const displayedEvents = useMemo(() => recentEvents.slice(-eventRows), [eventRows, recentEvents]);
  const queueBlockLabel = summarizeQueueBlock(queueBlock);

  // Chain header always shows the live queue, regardless of display filter.
  const chainEntries = useMemo(() => buildChainEntries(allEntries), [allEntries]);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Spec chain: main ─ #A ✓ ─ #B ● ─ #C ○ */}
      {chainEntries.length > 0 && (
        <Box marginBottom={1} gap={0}>
          <Text dimColor>main</Text>
          {chainEntries.map((entry) => {
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
            Queue paused: {queueBlockLabel ?? "waiting for main checks"}{queueBlock.baseSha ? ` at ${truncate(queueBlock.baseSha, 10)}` : ""}.
          </Text>
          <Text dimColor>Head PR #{queueBlock.headPrNumber ?? "?"} will resume automatically once main is healthy.</Text>
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
            isHead={entry.id === headEntryId}
            queueBlock={queueBlock}
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
