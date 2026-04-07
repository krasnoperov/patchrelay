import { Box, Text, useStdout } from "ink";
import type { ReviewAttemptRecord, ReviewQuillWatchSnapshot } from "../types.ts";
import { attemptLabel, attemptStateColor, formatSha, relativeTime, truncate, webhookLabel } from "./format.ts";

interface ListViewProps {
  snapshot: ReviewQuillWatchSnapshot;
  attempts: ReviewAttemptRecord[];
  selectedAttemptId: number | null;
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
        <Text dimColor>{` ${relativeTime(attempt.updatedAt)} ago`}</Text>
      </Box>
    );
}

export function ListView({ snapshot, attempts, selectedAttemptId }: ListViewProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const repoRows = Math.min(snapshot.repos.length, 5);
  const attemptRows = Math.max(4, rows - repoRows - 14);
  const visibleAttempts = attempts.slice(0, attemptRows);
  const visibleWebhooks = snapshot.recentWebhooks.slice(0, 6);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Repositories</Text>
      {snapshot.repos.slice(0, repoRows).map((repo) => (
        <Box key={repo.repoId}>
          <Text>{truncate(repo.repoFullName, 28)}</Text>
          <Text dimColor>{`  base:${repo.baseBranch}`}</Text>
          <Text>{`  `}</Text>
          <Text color={repo.runningAttempts > 0 ? "yellow" : repo.failedAttempts > 0 ? "red" : "green"}>
            {`${repo.runningAttempts} running`}
          </Text>
          <Text dimColor>{`  ${repo.queuedAttempts} queued  ${repo.failedAttempts} failed`}</Text>
        </Box>
      ))}

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
        <Text bold>Recent Webhooks</Text>
        {visibleWebhooks.length === 0 ? (
          <Text dimColor>No webhook deliveries yet.</Text>
        ) : (
          visibleWebhooks.map((event) => (
            <Box key={event.deliveryId}>
              <Text dimColor>{relativeTime(event.receivedAt).padStart(4, " ")}</Text>
              <Text>{` ${truncate(webhookLabel(event), 80)}`}</Text>
            </Box>
          ))
        )}
      </Box>
    </Box>
  );
}
