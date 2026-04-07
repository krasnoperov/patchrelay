import type { CodexTurnSummary, CodexThreadSummary } from "./codex-types.ts";

export function getThreadTurns(thread: Pick<CodexThreadSummary, "turns"> | null | undefined): CodexTurnSummary[] {
  return Array.isArray(thread?.turns) ? thread.turns : [];
}
