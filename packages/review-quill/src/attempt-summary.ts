import type { ReviewAttemptRecord } from "./types.ts";

function attemptTimestamp(attempt: ReviewAttemptRecord): number {
  return new Date(attempt.updatedAt).getTime();
}

function isLaterAttempt(left: ReviewAttemptRecord, right: ReviewAttemptRecord): boolean {
  const leftTime = attemptTimestamp(left);
  const rightTime = attemptTimestamp(right);
  if (leftTime !== rightTime) {
    return leftTime > rightTime;
  }
  return left.id > right.id;
}

export function getLatestAttemptsByPullRequest(attempts: ReviewAttemptRecord[]): ReviewAttemptRecord[] {
  const latestByPullRequest = new Map<string, ReviewAttemptRecord>();
  for (const attempt of attempts) {
    const key = `${attempt.repoFullName}#${attempt.prNumber}`;
    const current = latestByPullRequest.get(key);
    if (!current || isLaterAttempt(attempt, current)) {
      latestByPullRequest.set(key, attempt);
    }
  }
  return [...latestByPullRequest.values()].sort((left, right) => {
    const leftTime = attemptTimestamp(left);
    const rightTime = attemptTimestamp(right);
    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }
    return right.id - left.id;
  });
}
