import type { ReviewAttemptRecord } from "../types.ts";
import { UsageError } from "./args.ts";

export function parseAttemptId(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === true || typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new UsageError(`Attempt id must be a positive integer. Received: ${String(value)}`);
  }
  return Number(value.trim());
}

export function selectTranscriptAttempt(
  attempts: ReviewAttemptRecord[],
  attemptId?: number,
): { attempt: ReviewAttemptRecord; notice?: string } {
  if (attemptId !== undefined) {
    const match = attempts.find((attempt) => attempt.id === attemptId);
    if (!match) {
      throw new UsageError(`No recorded review attempt #${attemptId} for that pull request.`);
    }
    return { attempt: match };
  }

  const latest = attempts[0];
  const withThread = attempts.find((attempt) => attempt.threadId);
  if (withThread) {
    return {
      attempt: withThread,
      ...(latest && latest.id !== withThread.id && latest.stale && !latest.threadId
        ? {
            notice: `Newest attempt #${latest.id} is stale and has no stored Codex thread. Showing latest attempt with a stored thread instead (#${withThread.id}).`,
          }
        : {}),
    };
  }

  if (latest?.stale) {
    throw new UsageError(`Newest attempt #${latest.id} is stale and has no stored Codex thread. ${latest.staleReason ?? ""}`.trim());
  }

  throw new UsageError("No recorded review attempt with a stored Codex thread was found for that pull request.");
}
