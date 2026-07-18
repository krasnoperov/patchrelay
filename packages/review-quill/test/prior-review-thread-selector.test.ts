import assert from "node:assert/strict";
import test from "node:test";
import { SqliteStore } from "../src/db/sqlite-store.ts";
import { selectPriorReviewThread } from "../src/prior-review-thread-selector.ts";
import type { CodexThreadSummary, ReviewAttemptRecord } from "../src/types.ts";

const transcript: CodexThreadSummary = {
  id: "thread-1",
  turns: [{ id: "turn-1", status: "completed", items: [] }],
};
const attempt: ReviewAttemptRecord = {
  id: 1,
  repoFullName: "owner/repo",
  prNumber: 7,
  headSha: "old-head",
  status: "completed",
  conclusion: "approved",
  promptFingerprint: "prompt-1",
  threadId: "thread-1",
  turnId: "turn-1",
  reviewSurfaceMode: "head",
  baseSha: "base-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:01:00.000Z",
};

function select(overrides: {
  enabled?: boolean;
  identity?: { patchId: string; baseSha: string; mode: "head" | "integration_tree" };
  currentHeadSha?: string;
  promptFingerprint?: string;
  attempt?: ReviewAttemptRecord;
  transcript?: CodexThreadSummary;
} = {}) {
  return selectPriorReviewThread({
    enabled: overrides.enabled ?? true,
    identity: overrides.identity ?? { patchId: "patch-2", baseSha: "base-1", mode: "head" },
    currentHeadSha: overrides.currentHeadSha ?? "new-head",
    promptFingerprint: overrides.promptFingerprint ?? "prompt-1",
    latest: { attempt: overrides.attempt ?? attempt, transcript: overrides.transcript ?? transcript },
  });
}

test("selectPriorReviewThread accepts only a completed terminal transcript boundary", () => {
  assert.deepEqual(select(), {
    kind: "selected",
    candidate: {
      sourceAttemptId: 1,
      threadId: "thread-1",
      lastTurnId: "turn-1",
      priorHeadSha: "old-head",
      promptFingerprint: "prompt-1",
      completedAt: "2026-01-01T00:01:00.000Z",
    },
  });
  assert.equal(select({ attempt: { ...attempt, conclusion: "declined" } }).kind, "selected");
});

test("selectPriorReviewThread rejects each unsafe identity and transcript mismatch", () => {
  const cases: Array<[string, ReturnType<typeof select>]> = [
    ["disabled", select({ enabled: false })],
    ["same_head", select({ currentHeadSha: "old-head" })],
    ["prior_not_decisive", select({ attempt: { ...attempt, status: "failed" } })],
    ["carry_forward_attempt", select({ attempt: { ...attempt, priorAttemptId: 99 } })],
    ["missing_thread_state", select({ attempt: { ...attempt, threadId: undefined } })],
    ["surface_mismatch", select({ identity: { patchId: "p", baseSha: "base-1", mode: "integration_tree" } })],
    ["base_mismatch", select({ identity: { patchId: "p", baseSha: "base-2", mode: "head" } })],
    ["prompt_mismatch", select({ promptFingerprint: "prompt-2" })],
    ["thread_mismatch", select({ transcript: { ...transcript, id: "other-thread" } })],
    ["terminal_turn_mismatch", select({ transcript: { ...transcript, turns: [...transcript.turns, { id: "turn-2", status: "completed", items: [] }] } })],
    ["terminal_turn_mismatch", select({ transcript: { ...transcript, turns: [{ id: "turn-1", status: "failed", items: [] }] } })],
  ];
  for (const [reason, result] of cases) assert.deepEqual(result, { kind: "miss", reason });
  assert.deepEqual(selectPriorReviewThread({
    enabled: true,
    currentHeadSha: "new-head",
    promptFingerprint: "prompt-1",
  }), { kind: "miss", reason: "identity_unavailable" });
});

test("latest different-head lookup returns the newest row even when only an older transcript is valid", () => {
  const store = new SqliteStore(":memory:");
  const older = store.createAttempt({
    repoFullName: "owner/repo", prNumber: 7, headSha: "head-1", status: "completed", conclusion: "approved",
  });
  store.updateAttempt(older.id, { threadId: "thread-old", turnId: "turn-old", transcript: {
    id: "thread-old", turns: [{ id: "turn-old", status: "completed", items: [] }],
  } });
  const newest = store.createAttempt({
    repoFullName: "owner/repo", prNumber: 7, headSha: "head-2", status: "failed",
  });

  const result = store.getLatestDifferentHeadAttemptWithTranscript("owner/repo", 7, "head-3");
  assert.equal(result?.attempt.id, newest.id);
  assert.equal(result?.transcript, undefined);
  store.close();
});
