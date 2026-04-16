import { Box, Text, useStdout } from "ink";
import type { ReviewAttemptRecord, ReviewQuillWatchSnapshot } from "../types.ts";
import { attemptLabel, attemptStateColor, formatSha, relativeTime, truncate } from "./format.ts";
import {
  clusterSummaryText,
  getCompactReviewQueueTokens,
  getRecentActivity,
  getRepoHealth,
  getReviewQueueText,
  projectStatsSummary,
  type CompactReviewQueueToken,
} from "./dashboard-model.ts";

interface ListViewProps {
  snapshot: ReviewQuillWatchSnapshot;
  attempts: ReviewAttemptRecord[];
  selectedAttemptId: number | null;
  selectedRepoFullName: string | null;
  compact?: boolean;
}

function AttemptRow({ attempt, selected, compact }: { attempt: ReviewAttemptRecord; selected: boolean; compact: boolean }): React.JSX.Element {
  const repoLabel = compact ? (attempt.repoFullName.split("/").at(-1) ?? attempt.repoFullName) : truncate(attempt.repoFullName, 24);
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{selected ? ">" : " "}</Text>
      <Text bold>{` #${attempt.prNumber}`}</Text>
      <Text>{` ${repoLabel}`}</Text>
      <Text dimColor>{` ${formatSha(attempt.headSha)}`}</Text>
      <Text>{` `}</Text>
      <Text color={attemptStateColor(attempt)}>{attemptLabel(attempt)}</Text>
      {compact ? null : attempt.status === "superseded" ? <Text dimColor>{` stale-head`}</Text> : null}
      {compact ? null : attempt.stale ? <Text dimColor>{` stale-worker`}</Text> : null}
      {attempt.stale && compact ? <Text dimColor>{` stale`}</Text> : null}
      <Text dimColor>{` ${relativeTime(attempt.updatedAt)} ago`}</Text>
    </Box>
  );
}

function CompactReviewQueueTokens({
  tokens,
  width,
}: {
  tokens: CompactReviewQueueToken[];
  width: number;
}): React.JSX.Element {
  const parts = tokens
    .map((entry) => `#${entry.prNumber}${entry.symbol}`);
  const visible = [];
  let used = 0;
  for (const part of parts) {
    const nextSize = part.length + (visible.length > 0 ? 1 : 0);
    if (used + nextSize > width) {
      break;
    }
    visible.push(part);
    used += nextSize;
  }
  if (visible.length === 0) {
    return <Text>{""}</Text>;
  }
  return (
    <Text>
      {visible.map((part, index) => {
        const token = tokens[index];
        if (!token) {
          return null;
        }
        return (
          <Text key={part} color={token.color}>
            {index === 0 ? part : ` ${part}`}
          </Text>
        );
      })}
    </Text>
  );
}

export function ListView({
  snapshot,
  attempts,
  selectedAttemptId,
  selectedRepoFullName,
  compact = false,
}: ListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const width = Math.max(20, stdout?.columns ?? 80);
  const repoRows = compact ? Math.min(snapshot.repos.length, Math.max(3, rows - 7)) : Math.min(snapshot.repos.length, 5);
  const attemptRows = Math.max(1, rows - repoRows * 2 - (compact ? 4 : 11));
  const visibleAttempts = attempts.slice(0, attemptRows);
  const repoLookup = new Map(snapshot.repos.map((repo) => [repo.repoFullName, repo]));
  const visibleActivity = compact ? [] : getRecentActivity(snapshot, repoLookup).slice(0, 6);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Review Overview</Text>
      <Text dimColor>{clusterSummaryText(snapshot, compact)}</Text>
      {snapshot.repos.slice(0, repoRows).map((repo) => {
        const health = getRepoHealth(snapshot, repo);
        const queueText = getReviewQueueText(snapshot, repo, compact);
        const queueTokens = compact ? getCompactReviewQueueTokens(snapshot, repo) : [];
        const queueWidth = Math.max(6, width - 20);
        return (
          <Box key={repo.repoId} flexDirection="column">
            <Box>
              <Text color={repo.repoFullName === selectedRepoFullName ? "cyan" : "gray"}>
                {repo.repoFullName === selectedRepoFullName ? ">" : " "}
              </Text>
              <Text bold>{repo.repoId}</Text>
            </Box>
            {compact ? (
              queueTokens.length === 0 ? (
                <Box paddingLeft={2}>
                  <Text dimColor>{truncate(queueText, queueWidth)}</Text>
                </Box>
              ) : (
                <Box paddingLeft={2}>
                  <CompactReviewQueueTokens tokens={queueTokens} width={queueWidth} />
                </Box>
              )
            ) : (
              <>
                <Text dimColor>{`  ${truncate(repo.repoFullName, 28)}`}</Text>
                <Text>{`  `}</Text>
                <Text color={health.color}>{health.label}</Text>
                <Text dimColor>{`  ${projectStatsSummary(snapshot, repo, compact)}`}</Text>
              </>
            )}
            {compact ? null : (
              <Box paddingLeft={2}>
                <Text color={health.color}>{`Reviews: ${truncate(queueText, 100)}`}</Text>
              </Box>
            )}
          </Box>
        );
      })}

      {!compact ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Attempts</Text>
          {visibleAttempts.length === 0 ? (
            <Text dimColor>No review attempts yet.</Text>
          ) : (
            visibleAttempts.map((attempt) => (
              <AttemptRow
                key={attempt.id}
                attempt={attempt}
                selected={attempt.id === selectedAttemptId}
                compact={compact}
              />
            ))
          )}
        </Box>
      ) : null}

      {!compact ? (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Recent Activity</Text>
          {visibleActivity.length === 0 ? (
            <Text dimColor>No recent activity yet.</Text>
          ) : (
            visibleActivity.map((item) => (
              <Box key={item.key}>
                <Text dimColor>{item.age.padStart(4, " ")}</Text>
                <Text>{` ${truncate(item.message, compact ? Math.max(24, width - 8) : 90)}`}</Text>
              </Box>
            ))
          )}
        </Box>
      ) : null}
    </Box>
  );
}
