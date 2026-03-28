import { useMemo } from "react";
import { Box, Text, useStdout } from "ink";
import type { QueueEntry, QueueEventSummary } from "../types.ts";
import { formatEventSummary, relativeTime, statusColor, truncate } from "./format.ts";

interface QueueListViewProps {
  entries: QueueEntry[];
  selectedEntryId: string | null;
  recentEvents: QueueEventSummary[];
  headEntryId: string | null;
}

const CHROME_ROWS = 13;

function QueueRow({
  entry,
  selected,
  branchWidth,
  isHead,
}: {
  entry: QueueEntry;
  selected: boolean;
  branchWidth: number;
  isHead: boolean;
}): React.JSX.Element {
  const retryText = `${entry.retryAttempts}/${entry.maxRetries}`;
  const ciText = entry.ciRetries > 0 ? ` ci:${entry.ciRetries}` : "";
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "›" : " "}</Text>
      <Text color={isHead ? "green" : "gray"}>{isHead ? "*" : " "}</Text>
      <Text> {String(entry.position).padStart(2, " ")} </Text>
      <Text bold>#{String(entry.prNumber).padStart(4, " ")}</Text>
      <Text> </Text>
      <Text color={statusColor(entry.status)}>{entry.status.padEnd(14, " ")}</Text>
      <Text> </Text>
      <Text>{retryText.padEnd(4, " ")}</Text>
      <Text> </Text>
      <Text dimColor>{relativeTime(entry.updatedAt).padStart(4, " ")}</Text>
      <Text> </Text>
      <Text>{truncate(entry.branch, branchWidth)}</Text>
      <Text dimColor>{ciText}</Text>
    </Box>
  );
}

export function QueueListView({
  entries,
  selectedEntryId,
  recentEvents,
  headEntryId,
}: QueueListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const cols = stdout?.columns ?? 100;
  const branchWidth = Math.max(12, cols - 36);
  const eventRows = Math.min(8, Math.max(4, rows - entries.length - CHROME_ROWS));
  const displayedEvents = useMemo(() => recentEvents.slice(-eventRows), [eventRows, recentEvents]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor> s h pos pr    status          rt   ago branch</Text>
      {entries.length === 0 ? (
        <Text dimColor>No queue entries in this filter.</Text>
      ) : (
        entries.map((entry) => (
          <QueueRow
            key={entry.id}
            entry={entry}
            selected={entry.id === selectedEntryId}
            branchWidth={branchWidth}
            isHead={entry.id === headEntryId}
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
