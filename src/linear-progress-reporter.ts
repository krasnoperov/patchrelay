import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { LinearAgentActivityContent } from "./types.ts";

export class LinearProgressReporter {
  constructor(
    _db: PatchRelayDatabase,
    _emitActivity: (
      issue: IssueRecord,
      content: LinearAgentActivityContent,
      options?: { ephemeral?: boolean },
    ) => Promise<void>,
  ) {}

  maybeEmitProgress(_notification: { method: string; params: Record<string, unknown> }, _run: RunRecord): void {
    // Keep routine Codex progress in local/operator surfaces rather than
    // turning every planning or reasoning update into Linear thread chatter.
    return;
  }

  clearProgress(_runId: number): void {
    return;
  }
}
