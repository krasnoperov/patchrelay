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

function compactEntryStatus(entryStatus: string): string {
  switch (entryStatus) {
    case "queued":
      return "waiting";
    case "preparing_head":
      return "prep";
    case "validating":
      return "testing";
    case "merging":
      return "merging";
    case "merged":
      return "merged";
    case "evicted":
      return "repair";
    case "dequeued":
      return "removed";
    default:
      return entryStatus;
  }
}

export function ProjectDetailView({
  repo,
  selectedEntryId,
  detail,
  filter,
}: ProjectDetailViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const width = stdout?.columns ?? 80;
  const compact = width < 95;

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
        <Text color={repo.serviceState === "initializing" ? "cyan" : "red"}>
          {repo.serviceState === "initializing"
            ? `Merge Steward is still initializing ${repo.repoId}.`
            : repo.serviceState === "failed"
              ? `Merge Steward failed to initialize ${repo.repoId}.`
              : `Queue data is unavailable for ${repo.repoId}.`}
        </Text>
        {repo.serviceMessage ? <Text dimColor>{repo.serviceMessage}</Text> : null}
        {repo.error && repo.error !== repo.serviceMessage ? <Text dimColor>{repo.error}</Text> : null}
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
  const eventRows = compact ? 4 : 6;
  const visibleEvents = detail
    ? detail.events.slice(-eventRows)
    : snapshot.recentEvents.slice(-eventRows);
  const chainEntries = getChainEntries(snapshot);
  const chainText = chainEntries.length > 0
    ? chainEntries.map((entry) => {
      const ci = ciStatusIcon(entry);
      return `#${entry.prNumber}${ci.icon}`;
    }).join(" ")
    : "empty";

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text bold>{repo.repoId}</Text>
        <Text>{`  `}</Text>
        <Text color={health.color}>{compact ? health.label.slice(0, 5) : health.label}</Text>
      </Box>
      <Text dimColor>{` ${projectStatsSummary(snapshot, compact)}`}</Text>
      {compact ? null : <Text dimColor>{runtimeSummary(snapshot)}</Text>}
      <Text dimColor>{compact
        ? `Queue: ${truncate(chainText, width - 10)}`
        : `Queue: main -> ${truncate(chainText, width - 18)}`}
      </Text>
      {compact ? null : queueBlockSummary ? <Text color="yellow">{queueBlockSummary}</Text> : null}

      {compact ? null : (
        <>
          <Text dimColor>
            GitHub required checks: {snapshot.githubPolicy.requiredChecks.length > 0 ? snapshot.githubPolicy.requiredChecks.join(", ") : "(none)"}
          </Text>
          {snapshot.githubPolicy.fetchedAt ? (
            <Text dimColor>
              Policy fetched {relativeTime(snapshot.githubPolicy.fetchedAt)} ago
              {snapshot.githubPolicy.lastRefreshReason
                ? ` via ${snapshot.githubPolicy.lastRefreshReason}${snapshot.githubPolicy.lastRefreshChanged === null ? "" : snapshot.githubPolicy.lastRefreshChanged ? " (changed)" : " (unchanged)"}`
                : ""}
            </Text>
          ) : null}
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Pull Requests</Text>
        {visibleEntries.length === 0 ? (
          <Text dimColor>No queue entries in this filter.</Text>
        ) : (
          visibleEntries.map((entry) => {
            const ci = ciStatusIcon(entry);
            const isHead = snapshot.summary.headEntryId === entry.id;
            const isSelected = entry.id === selectedEntryId;
            const statusColor = entry.status === "evicted" ? "red" : ci.color;
            const statusText = compact ? compactEntryStatus(entry.status) : humanStatus(entry.status, entry);
            return (
              <Box key={entry.id} flexDirection="column">
                <Box>
                  <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? ">" : " "}</Text>
                  <Text bold>{`#${entry.prNumber}`}</Text>
                  {entry.issueKey ? <Text>{` ${entry.issueKey}`}</Text> : null}
                  <Text>{`  `}</Text>
                  <Text color={ci.color}>{ci.icon}</Text>
                  <Text color={statusColor}>{` ${statusText}`}</Text>
                  {compact ? null : (
                    <>
                      <Text dimColor>{`  updated ${relativeTime(entry.updatedAt)} ago`}</Text>
                      {isHead ? <Text dimColor>{`  · ${humanStatus(entry.status, entry)} head`}</Text> : null}
                    </>
                  )}
                </Box>
                {(isSelected || entry.status === "evicted" || (isHead && queueBlockSummary)) && (
                  <Box paddingLeft={2}>
                    <Text dimColor>{truncate(describeEntry(entry, { isHead, queueBlockSummary }), compact ? width - 4 : 110)}</Text>
                  </Box>
                )}
              </Box>
            );
          })
        )}
      </Box>

      {selectedEntry ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>{`Selected PR #${selectedEntry.prNumber}`}</Text>
          {compact ? (
            <Text dimColor>{`head ${shortSha(selectedEntry.headSha)} · base ${shortSha(selectedEntry.baseSha)}`}</Text>
          ) : (
            <Text dimColor>
              {selectedEntry.branch} · head {shortSha(selectedEntry.headSha)} · base {shortSha(selectedEntry.baseSha)}
            </Text>
          )}
          {compact ? null : <Text dimColor>{`Test branch: ${specChainLabel(selectedEntry, snapshot.entries)}`}</Text>}
          {detail?.incidents.length
            ? detail.incidents.slice(-2).map((incident) => (
              <Text key={incident.id} color="red">
                {relativeTime(incident.at)} ago · {incident.failureClass} · {incident.outcome}
              </Text>
            ))
            : null}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>{detail ? "Selected PR Activity" : "Recent Project Activity"}</Text>
        {visibleEvents.length === 0 ? (
          <Text dimColor>No queue events yet.</Text>
        ) : (
          visibleEvents.map((event) => (
            <Box key={"id" in event && event.id ? String(event.id) : `${event.entryId}-${event.at}`} gap={1}>
              <Text dimColor>{relativeTime(event.at).padStart(4, " ")}</Text>
              <Text>{truncate(formatEventNarrative(event), compact ? Math.max(12, width - 8) : 106)}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
