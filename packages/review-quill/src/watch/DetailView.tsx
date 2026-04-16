import { Box, Text } from "ink";
import type { ReviewAttemptDetail } from "../types.ts";
import { attemptLabel, attemptStateColor, formatSha, formatTimestamp, relativeTime, truncate } from "./format.ts";

interface DetailViewProps {
  detail: ReviewAttemptDetail | null;
  compact?: boolean;
}

export function DetailView({ detail, compact = false }: DetailViewProps): React.JSX.Element {
  if (!detail) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Loading attempt detail…</Text>
      </Box>
    );
  }

  const { attempt } = detail;
  const currentPullRequest = detail.currentPullRequest;
  const latestAttempt = detail.relatedAttempts[0] ?? attempt;
  const isLatestForPullRequest = latestAttempt.id === attempt.id;
  const resultLabel = attempt.status === "completed"
    ? attempt.conclusion === "approved"
      ? "Latest stored review result: approved"
      : attempt.conclusion === "declined"
        ? "Latest stored review result: requested changes"
        : `Latest stored review result: ${attemptLabel(attempt)}`
    : `Attempt state: ${attemptLabel(attempt)}`;
  const reviewedHeadLabel = isLatestForPullRequest
    ? "This is the latest stored review result for this pull request."
    : `This is historical review output. A newer attempt (#${latestAttempt.id}) exists for this pull request.`;

  if (compact) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>{`${attempt.repoFullName} PR #${attempt.prNumber}`}</Text>
        <Box>
          <Text>Result: </Text>
          <Text color={attemptStateColor(attempt)}>{attemptLabel(attempt)}</Text>
          {attempt.status === "completed" && attempt.conclusion === "approved" ? <Text dimColor> (approved)</Text> : null}
        </Box>
        <Text>{attempt.staleReason ? `Stale: ${attempt.staleReason}` : resultLabel}</Text>
        {currentPullRequest ? (
          <Text>{`PR state: ${currentPullRequest.state.toLowerCase()}${currentPullRequest.isDraft ? " (draft)" : ""}`}</Text>
        ) : null}
        <Text>{`Reviewed head: ${formatSha(attempt.headSha)}${currentPullRequest && currentPullRequest.headSha !== attempt.headSha ? " (outdated)" : ""}`}</Text>
        <Text dimColor>{`Updated: ${relativeTime(attempt.updatedAt)} ago`}</Text>
        {attempt.summary ? (
          <Text>{`Summary: ${truncate(attempt.summary, 140)}`}</Text>
        ) : (
          <Text>Summary: No summary captured.</Text>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text bold>Review History</Text>
          {detail.relatedAttempts.slice(0, 2).map((related) => (
            <Box key={related.id}>
              <Text>{`#${related.id}`}</Text>
              <Text>{` ${formatSha(related.headSha)}`}</Text>
              <Text>{` `}</Text>
              <Text color={attemptStateColor(related)}>{attemptLabel(related)}</Text>
              <Text dimColor>{` ${relativeTime(related.updatedAt)} ago`}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`${attempt.repoFullName} PR #${attempt.prNumber}`}</Text>
      <Box>
        <Text>Result: </Text>
        <Text color={attemptStateColor(attempt)}>{attemptLabel(attempt)}</Text>
      </Box>
      <Text>{resultLabel}</Text>
      {currentPullRequest ? (
        <Text>{`PR state: ${currentPullRequest.state.toLowerCase()}${currentPullRequest.isDraft ? " (draft)" : ""}`}</Text>
      ) : null}
      {attempt.staleReason ? <Text>{`Stale: ${attempt.staleReason}`}</Text> : null}
      <Text>{`Reviewed head: ${formatSha(attempt.headSha)}`}</Text>
      {currentPullRequest ? (
        <Text>
          {`Current PR head: ${formatSha(currentPullRequest.headSha)}${currentPullRequest.headSha === attempt.headSha ? " (matches reviewed head)" : " (newer than this review result)"}`}
        </Text>
      ) : null}
      <Text>{reviewedHeadLabel}</Text>
      <Text>{`Created: ${formatTimestamp(attempt.createdAt)} (${relativeTime(attempt.createdAt)} ago)`}</Text>
      <Text>{`Updated: ${formatTimestamp(attempt.updatedAt)} (${relativeTime(attempt.updatedAt)} ago)`}</Text>
      {attempt.completedAt ? <Text>{`Completed: ${formatTimestamp(attempt.completedAt)} (${relativeTime(attempt.completedAt)} ago)`}</Text> : null}
      {attempt.externalCheckRunId ? <Text>{`Check run: ${attempt.externalCheckRunId}`}</Text> : null}
      {attempt.threadId ? <Text>{`Thread: ${attempt.threadId}`}</Text> : null}
      {attempt.turnId ? <Text>{`Turn: ${attempt.turnId}`}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Review Summary</Text>
        <Text>{attempt.summary ?? "No summary captured."}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Review History</Text>
        {detail.relatedAttempts.map((related) => (
          <Box key={related.id}>
            <Text>{`#${related.id}`}</Text>
            <Text>{` ${formatSha(related.headSha)}`}</Text>
            <Text>{` `}</Text>
            <Text color={attemptStateColor(related)}>{attemptLabel(related)}</Text>
            <Text dimColor>{` ${relativeTime(related.updatedAt)} ago`}</Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}
