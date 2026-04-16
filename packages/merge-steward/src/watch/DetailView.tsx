import { Box, Text } from "ink";
import type { GitHubPolicyState, QueueBlockState, QueueEntryDetail } from "../types.ts";
import { formatEntryEvent, humanStatus, nextStepLabel, relativeTime, shortSha, statusColor, summarizeQueueBlock } from "./format.ts";
import { EntryStateGraph } from "./EntryStateGraph.tsx";
import { ExternalRepairObservation } from "./ExternalRepairObservation.tsx";
import { buildEntryStateGraph, buildExternalRepairObservations } from "./state-visualization.ts";

interface DetailViewProps {
  detail: QueueEntryDetail | null;
  isHead: boolean;
  activeIndex: number | null;
  activeCount: number;
  headPrNumber: number | null;
  queueBlock: QueueBlockState | null;
  githubPolicy: GitHubPolicyState;
}

export function DetailView({
  detail,
  isHead,
  activeIndex,
  activeCount,
  headPrNumber,
  queueBlock,
  githubPolicy,
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
    queueBlock,
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Header: PR, status, what's happening */}
      <Box gap={2}>
        <Text bold>#{entry.prNumber}</Text>
        {entry.issueKey ? <Text>{entry.issueKey}</Text> : null}
        <Text color={statusColor(entry.status, entry)}>{humanStatus(entry.status, entry)}</Text>
        <Text dimColor>{`· ${nextStepLabel(entry.status, entry)}`}</Text>
      </Box>

      {/* Branch + git refs */}
      <Box gap={2}>
        <Text dimColor>{entry.branch}</Text>
        <Text dimColor>head {shortSha(entry.headSha)}</Text>
        <Text dimColor>base {shortSha(entry.baseSha)}</Text>
      </Box>

      {/* What CI is testing */}
      {entry.specBranch && (
        <Box gap={2}>
          <Text dimColor>tested as</Text>
          <Text>{entry.specBranch}</Text>
          <Text dimColor>{`(${shortSha(entry.specSha)} ← ${entry.specBasedOn ? "PR ahead" : "main"})`}</Text>
        </Box>
      )}

      {/* Retry count — only when retries happened */}
      {entry.retryAttempts > 0 && (
        <Text color="yellow">retry {entry.retryAttempts}/{entry.maxRetries}</Text>
      )}

      {/* Queue block warning */}
      {isHead && queueBlock && (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">Queue paused: {summarizeQueueBlock(queueBlock) ?? `waiting for ${queueBlock.baseBranch} checks`}.</Text>
          <Text dimColor>
            {queueBlock.missingRequiredChecks.length > 0
              ? `Fix ${queueBlock.baseBranch} first, then reconcile this repo to resume the queue.`
              : `Will resume automatically once ${queueBlock.baseBranch} is healthy.`}
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>GitHub Policy</Text>
        <Text dimColor>
          Required checks: {githubPolicy.requiredChecks.length > 0 ? githubPolicy.requiredChecks.join(", ") : "(none)"}
        </Text>
        {githubPolicy.fetchedAt ? <Text dimColor>Fetched: {githubPolicy.fetchedAt}</Text> : null}
        {githubPolicy.lastRefreshReason ? (
          <Text dimColor>
            Last refresh: {githubPolicy.lastRefreshReason}
            {githubPolicy.lastRefreshChanged === null ? "" : githubPolicy.lastRefreshChanged ? " (changed)" : " (unchanged)"}
          </Text>
        ) : null}
      </Box>

      <EntryStateGraph main={graph.main} exits={graph.exits} />
      <ExternalRepairObservation observations={observations} />

      {/* Incidents — only when there are any */}
      {incidents.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Incidents</Text>
          {incidents.map((incident) => (
            <Box key={incident.id} gap={1}>
              <Text dimColor>{relativeTime(incident.at).padStart(4)}</Text>
              <Text color="red">{incident.failureClass}</Text>
              <Text dimColor>{incident.outcome}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Events */}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Events</Text>
        {events.length === 0 ? (
          <Text dimColor>No events yet.</Text>
        ) : (
          events.slice(-16).map((event) => (
            <Box key={event.id ?? `${event.entryId}-${event.at}`} gap={1}>
              <Text dimColor>{relativeTime(event.at).padStart(4)}</Text>
              <Text>{formatEntryEvent(event)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
