import { Box, Text, useStdout } from "ink";
import type { ReviewAttemptRecord, ReviewQuillWatchSnapshot } from "../types.ts";
import { attemptLabel, attemptStateColor, formatSha, relativeTime, truncate } from "./format.ts";
import { getClusterSummary, getRecentActivity, getRepoHealth, getReviewQueueText, projectStatsSummary } from "./dashboard-model.ts";

interface ListViewProps {
  snapshot: ReviewQuillWatchSnapshot;
  attempts: ReviewAttemptRecord[];
  selectedAttemptId: number | null;
  selectedRepoFullName: string | null;
}

function AttemptRow({ attempt, selected }: { attempt: ReviewAttemptRecord; selected: boolean }): React.JSX.Element {
  return (
    <Box>
      <Text color={selected ? "cyan" : "gray"}>{selected ? "\u25b8" : " "}</Text>
      <Text bold>{` #${attempt.prNumber}`}</Text>
      <Text>{` ${truncate(attempt.repoFullName, 24)}`}</Text>
        <Text dimColor>{` ${formatSha(attempt.headSha)}`}</Text>
        <Text>{` `}</Text>
        <Text color={attemptStateColor(attempt)}>{attemptLabel(attempt)}</Text>
        {attempt.status === "superseded" ? <Text dimColor>{` stale-head`}</Text> : null}
        {attempt.stale ? <Text dimColor>{` stale-worker`}</Text> : null}
        <Text dimColor>{` ${relativeTime(attempt.updatedAt)} ago`}</Text>
      </Box>
    );
}

export function ListView({ snapshot, attempts, selectedAttemptId, selectedRepoFullName }: ListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const repoRows = Math.min(snapshot.repos.length, 5);
  const attemptRows = Math.max(4, rows - repoRows * 2 - 11);
  const visibleAttempts = attempts.slice(0, attemptRows);
  const cluster = getClusterSummary(snapshot);
  const repoLookup = new Map(snapshot.repos.map((repo) => [repo.repoFullName, repo]));
  const visibleActivity = getRecentActivity(snapshot, repoLookup).slice(0, 6);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Review Overview</Text>
      <Text dimColor>
        {cluster.total} repositories · {cluster.connected} connected · {cluster.active} active · {cluster.queued} queued · {cluster.stuck} stuck · {cluster.attention} need attention
      </Text>
      {snapshot.repos.slice(0, repoRows).map((repo) => {
        const health = getRepoHealth(snapshot, repo);
        const queueText = getReviewQueueText(snapshot, repo);
        return (
          <Box key={repo.repoId} flexDirection="column">
            <Box>
              <Text color={repo.repoFullName === selectedRepoFullName ? "cyan" : "gray"}>
                {repo.repoFullName === selectedRepoFullName ? "\u25b8" : " "}
              </Text>
              <Text bold>{repo.repoId}</Text>
              <Text dimColor>{`  ${truncate(repo.repoFullName, 28)}`}</Text>
              <Text>{`  `}</Text>
              <Text color={health.color}>{health.label}</Text>
              <Text dimColor>{`  ${projectStatsSummary(snapshot, repo)}`}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text dimColor>{`Reviews: ${truncate(queueText, 100)}`}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text color={health.color}>{truncate(health.detail, 110)}</Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Attempts</Text>
        {visibleAttempts.length === 0 ? (
          <Text dimColor>No review attempts yet.</Text>
        ) : (
          visibleAttempts.map((attempt) => (
            <AttemptRow key={attempt.id} attempt={attempt} selected={attempt.id === selectedAttemptId} />
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent Activity</Text>
        {visibleActivity.length === 0 ? (
          <Text dimColor>No recent activity yet.</Text>
        ) : (
          visibleActivity.map((item) => (
            <Box key={item.key}>
              <Text dimColor>{item.age.padStart(4, " ")}</Text>
              <Text>{` ${truncate(item.message, 90)}`}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
