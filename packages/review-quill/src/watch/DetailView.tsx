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
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{`${attempt.repoFullName} PR #${attempt.prNumber}`}</Text>
      <Box>
        <Text>Status: </Text>
        <Text color={attemptStateColor(attempt)}>{attemptLabel(attempt)}</Text>
      </Box>
      <Text>{`Head SHA: ${formatSha(attempt.headSha)}`}</Text>
      <Text>{`Created: ${attempt.createdAt} (${relativeTime(attempt.createdAt)} ago)`}</Text>
      <Text>{`Updated: ${attempt.updatedAt} (${relativeTime(attempt.updatedAt)} ago)`}</Text>
      {attempt.completedAt ? <Text>{`Completed: ${attempt.completedAt}`}</Text> : null}
      {attempt.externalCheckRunId ? <Text>{`Check run: ${attempt.externalCheckRunId}`}</Text> : null}
      {attempt.threadId ? <Text>{`Thread: ${attempt.threadId}`}</Text> : null}
      {attempt.turnId ? <Text>{`Turn: ${attempt.turnId}`}</Text> : null}

      <Box marginTop={1} flexDirection="column">
        <Text bold>Summary</Text>
        <Text>{truncate(attempt.summary ?? "No summary captured.", 400)}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>Related Attempts</Text>
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
