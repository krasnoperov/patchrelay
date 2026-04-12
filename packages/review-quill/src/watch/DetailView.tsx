import { Box, Text } from "ink";
import type { ReviewAttemptDetail } from "../types.ts";
import { attemptLabel, attemptStateColor, formatSha, relativeTime, truncate } from "./format.ts";

interface DetailViewProps {
  detail: ReviewAttemptDetail | null;
}

export function DetailView({ detail }: DetailViewProps): React.JSX.Element {
  if (!detail) {
    return (
      <Box marginTop={1}>
        <Text dimColor>Loading attempt detail…</Text>
      </Box>
    );
  }

  const { attempt } = detail;
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
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`${attempt.repoFullName} PR #${attempt.prNumber}`}</Text>
      <Box>
        <Text>Result: </Text>
        <Text color={attemptStateColor(attempt)}>{attemptLabel(attempt)}</Text>
      </Box>
      <Text>{resultLabel}</Text>
      {attempt.staleReason ? <Text>{`Stale: ${attempt.staleReason}`}</Text> : null}
      <Text>{`Reviewed head: ${formatSha(attempt.headSha)}`}</Text>
      <Text>{reviewedHeadLabel}</Text>
      <Text>{`Created: ${attempt.createdAt} (${relativeTime(attempt.createdAt)} ago)`}</Text>
      <Text>{`Updated: ${attempt.updatedAt} (${relativeTime(attempt.updatedAt)} ago)`}</Text>
      {attempt.completedAt ? <Text>{`Completed: ${attempt.completedAt}`}</Text> : null}
      {attempt.externalCheckRunId ? <Text>{`Check run: ${attempt.externalCheckRunId}`}</Text> : null}
      {attempt.threadId ? <Text>{`Thread: ${attempt.threadId}`}</Text> : null}
      {attempt.turnId ? <Text>{`Turn: ${attempt.turnId}`}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Review Summary</Text>
        <Text>{truncate(attempt.summary ?? "No summary captured.", 400)}</Text>
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
