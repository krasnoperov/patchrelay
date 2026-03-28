import { Box, Text } from "ink";
import type { QueueEntryDetail } from "../types.ts";
import { formatEntryEvent, progressBar, relativeTime, shortSha, statusColor } from "./format.ts";
import { EntryStateGraph } from "./EntryStateGraph.tsx";
import { ExternalRepairObservation } from "./ExternalRepairObservation.tsx";
import { buildEntryStateGraph, buildExternalRepairObservations } from "./state-visualization.ts";

interface DetailViewProps {
  detail: QueueEntryDetail | null;
  isHead: boolean;
  activeIndex: number | null;
  activeCount: number;
  headPrNumber: number | null;
}

export function DetailView({
  detail,
  isHead,
  activeIndex,
  activeCount,
  headPrNumber,
}: DetailViewProps): React.JSX.Element {
  if (!detail) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Loading entry detail...</Text>
      </Box>
    );
  }

  const { entry, events, incidents } = detail;
  const graph = buildEntryStateGraph(detail);
  const observations = buildExternalRepairObservations(detail, {
    isHead,
    activeIndex,
    activeCount,
    headPrNumber,
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box gap={2}>
        <Text bold>#{entry.prNumber}</Text>
        <Text color={statusColor(entry.status)}>{entry.status}</Text>
        <Text dimColor>pos {entry.position}</Text>
        <Text dimColor>generation {entry.generation}</Text>
        <Text dimColor>retry {entry.retryAttempts}/{entry.maxRetries}</Text>
      </Box>
      <Text>{entry.branch}</Text>
      <Box gap={2}>
        <Text dimColor>head {shortSha(entry.headSha)}</Text>
        <Text dimColor>base {shortSha(entry.baseSha)}</Text>
        {entry.issueKey && <Text dimColor>{entry.issueKey}</Text>}
      </Box>

      {entry.maxRetries > 0 && (
        <Box gap={1} marginTop={1}>
          <Text dimColor>retry</Text>
          <Text>{progressBar(entry.retryAttempts, entry.maxRetries, 10)}</Text>
          <Text dimColor>{entry.retryAttempts}/{entry.maxRetries}</Text>
        </Box>
      )}

      <EntryStateGraph main={graph.main} exits={graph.exits} />
      <ExternalRepairObservation observations={observations} />

      <Box marginTop={1} flexDirection="column">
        <Text bold>Incidents</Text>
        {incidents.length === 0 ? (
          <Text dimColor>No incidents.</Text>
        ) : (
          incidents.map((incident) => (
            <Box key={incident.id} gap={1}>
              <Text dimColor>{relativeTime(incident.at).padStart(4, " ")}</Text>
              <Text color="red">{incident.failureClass}</Text>
              <Text dimColor>{incident.outcome}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Events</Text>
        {events.length === 0 ? (
          <Text dimColor>No events yet.</Text>
        ) : (
          events.slice(-16).map((event) => (
            <Box key={event.id ?? `${event.entryId}-${event.at}`} gap={1}>
              <Text dimColor>{relativeTime(event.at).padStart(4, " ")}</Text>
              <Text>{formatEntryEvent(event)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
