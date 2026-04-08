import { Box, Text, useStdout } from "ink";
import type { QueueEntryDetail, QueueWatchSnapshot } from "../types.ts";
import { buildDisplayEntries } from "./display-filter.ts";
import type { DashboardRepoState } from "./dashboard-model.ts";
import { describeEntry, getChainEntries, getRepoHealth, projectStatsSummary, runtimeSummary } from "./dashboard-model.ts";
import { ciStatusIcon, formatEventNarrative, humanStatus, relativeTime, shortSha, specChainLabel, summarizeQueueBlock, truncate } from "./format.ts";

interface ProjectDetailViewProps {
  repo: DashboardRepoState | null;
  selectedEntryId: string | null;
  detail: QueueEntryDetail | null;
  filter: "active" | "all";
}

function clampWindowStart(selectedIndex: number, itemCount: number, maxItems: number): number {
  if (itemCount <= maxItems) {
    return 0;
  }
  const half = Math.floor(maxItems / 2);
  return Math.max(0, Math.min(itemCount - maxItems, selectedIndex - half));
}

function selectedEntryIndex(snapshot: QueueWatchSnapshot | null, filter: "active" | "all", entryId: string | null): number {
  if (!snapshot || !entryId) {
    return 0;
  }
  const entries = buildDisplayEntries(snapshot.entries, filter);
  const index = entries.findIndex((entry) => entry.id === entryId);
  return index >= 0 ? index : 0;
}

export function ProjectDetailView({
  repo,
  selectedEntryId,
  detail,
  filter,
}: ProjectDetailViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;

  if (!repo) {
    return (
      <Box marginTop={1}>
        <Text dimColor>No project selected.</Text>
      </Box>
    );
  }

  if (!repo.snapshot) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color="red">Queue data is unavailable for {repo.repoId}.</Text>
        {repo.error ? <Text dimColor>{repo.error}</Text> : null}
      </Box>
    );
  }

  const snapshot = repo.snapshot;
  const health = getRepoHealth(repo);
  const queueBlockSummary = summarizeQueueBlock(snapshot.queueBlock);
  const entries = buildDisplayEntries(snapshot.entries, filter);
  const currentSelectedIndex = selectedEntryIndex(snapshot, filter, selectedEntryId);
  const maxEntryRows = Math.max(3, Math.floor((rows - 16) / 2));
  const entryWindowStart = clampWindowStart(currentSelectedIndex, entries.length, maxEntryRows);
  const visibleEntries = entries.slice(entryWindowStart, entryWindowStart + maxEntryRows);
  const selectedEntry = entries.find((entry) => entry.id === selectedEntryId)
    ?? snapshot.entries.find((entry) => entry.id === selectedEntryId)
    ?? null;
  const visibleEvents = detail
    ? detail.events.slice(-6)
    : snapshot.recentEvents.slice(-6);
  const chainEntries = getChainEntries(snapshot);
  const chainText = chainEntries.length > 0
    ? chainEntries.map((entry) => `#${entry.prNumber}`).join(" -> ")
    : "empty";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold>{repo.repoId}</Text>
        <Text dimColor>{`  ${repo.repoFullName}`}</Text>
        <Text>{`  `}</Text>
        <Text color={health.color}>{health.label}</Text>
      </Box>
      <Text dimColor>{projectStatsSummary(snapshot)}</Text>
      <Text dimColor>{runtimeSummary(snapshot)}</Text>
      <Text dimColor>{`Queue: main -> ${truncate(chainText, 96)}`}</Text>
      {queueBlockSummary ? <Text color="yellow">{queueBlockSummary}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Pull Requests</Text>
        {visibleEntries.length === 0 ? (
          <Text dimColor>No queue entries in this filter.</Text>
        ) : (
          visibleEntries.map((entry) => {
            const ci = ciStatusIcon(entry);
            const isHead = snapshot.summary.headEntryId === entry.id;
            return (
              <Box key={entry.id} flexDirection="column">
                <Box>
                  <Text color={entry.id === selectedEntryId ? "cyan" : "gray"}>{entry.id === selectedEntryId ? "\u25b8" : " "}</Text>
                  <Text bold>{`#${entry.prNumber}`}</Text>
                  {entry.issueKey ? <Text>{` ${entry.issueKey}`}</Text> : null}
                  <Text>{`  `}</Text>
                  <Text color={ci.color}>{ci.icon}</Text>
                  <Text>{` `}</Text>
                  <Text {...(entry.status === "evicted" ? { color: "red" as const } : {})}>{humanStatus(entry.status, entry)}</Text>
                  <Text dimColor>{`  updated ${relativeTime(entry.updatedAt)} ago`}</Text>
                </Box>
                {(entry.id === selectedEntryId || entry.status === "evicted" || (isHead && queueBlockSummary)) && (
                  <Box paddingLeft={2}>
                    <Text dimColor>{truncate(describeEntry(entry, { isHead, queueBlockSummary }), 110)}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {selectedEntry && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>{`Selected PR #${selectedEntry.prNumber}`}</Text>
          <Text dimColor>
            {selectedEntry.branch} · head {shortSha(selectedEntry.headSha)} · base {shortSha(selectedEntry.baseSha)}
          </Text>
          <Text dimColor>{`Test branch: ${specChainLabel(selectedEntry, snapshot.entries)}`}</Text>
          {detail?.incidents.length
            ? detail.incidents.slice(-2).map((incident) => (
              <Text key={incident.id} color="red">
                {relativeTime(incident.at)} ago · {incident.failureClass} · {incident.outcome}
              </Text>
            ))
            : null}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>{detail ? "Selected PR Activity" : "Recent Project Activity"}</Text>
        {visibleEvents.length === 0 ? (
          <Text dimColor>No queue events yet.</Text>
        ) : (
          visibleEvents.map((event) => (
            <Box key={"id" in event && event.id ? String(event.id) : `${event.entryId}-${event.at}`} gap={1}>
              <Text dimColor>{relativeTime(event.at).padStart(4, " ")}</Text>
              <Text>{truncate(formatEventNarrative(event), 106)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
