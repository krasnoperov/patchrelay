import type { ChangeIdentity } from "./carry-forward.ts";
import type { CodexThreadSummary, ReviewAttemptRecord } from "./types.ts";

export interface PriorReviewThreadCandidate {
  sourceAttemptId: number;
  threadId: string;
  lastTurnId: string;
  priorHeadSha: string;
  promptFingerprint: string;
  completedAt?: string;
}

export type PriorReviewThreadSelection =
  | { kind: "selected"; candidate: PriorReviewThreadCandidate }
  | { kind: "miss"; reason: string };

export function selectPriorReviewThread(input: {
  enabled: boolean;
  identity?: ChangeIdentity;
  currentHeadSha: string;
  promptFingerprint: string;
  latest?: { attempt: ReviewAttemptRecord; transcript?: CodexThreadSummary };
}): PriorReviewThreadSelection {
  if (!input.enabled) return { kind: "miss", reason: "disabled" };
  if (!input.identity) return { kind: "miss", reason: "identity_unavailable" };
  if (!input.latest) return { kind: "miss", reason: "no_prior_attempt" };

  const { attempt, transcript } = input.latest;
  if (attempt.headSha === input.currentHeadSha) return { kind: "miss", reason: "same_head" };
  if (attempt.status !== "completed" || (attempt.conclusion !== "approved" && attempt.conclusion !== "declined")) {
    return { kind: "miss", reason: "prior_not_decisive" };
  }
  if (attempt.priorAttemptId !== undefined) return { kind: "miss", reason: "carry_forward_attempt" };
  if (!attempt.threadId?.trim() || !attempt.turnId?.trim() || !transcript || transcript.turns.length === 0) {
    return { kind: "miss", reason: "missing_thread_state" };
  }
  if (attempt.reviewSurfaceMode !== input.identity.mode) return { kind: "miss", reason: "surface_mismatch" };
  if (attempt.baseSha !== input.identity.baseSha) return { kind: "miss", reason: "base_mismatch" };
  if (attempt.promptFingerprint !== input.promptFingerprint) return { kind: "miss", reason: "prompt_mismatch" };
  if (transcript.id !== attempt.threadId) return { kind: "miss", reason: "thread_mismatch" };
  const lastTurn = transcript.turns.at(-1);
  if (!lastTurn || lastTurn.id !== attempt.turnId || lastTurn.status !== "completed") {
    return { kind: "miss", reason: "terminal_turn_mismatch" };
  }
  return {
    kind: "selected",
    candidate: {
      sourceAttemptId: attempt.id,
      threadId: attempt.threadId,
      lastTurnId: attempt.turnId,
      priorHeadSha: attempt.headSha,
      promptFingerprint: input.promptFingerprint,
      ...(attempt.completedAt ? { completedAt: attempt.completedAt } : {}),
    },
  };
}
