import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { StageRunRecord } from "./types.ts";

export class StageTurnInputDispatcher {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
  ) {}

  routePendingInputs(stageRunId: number, threadId: string, turnId: string): void {
    for (const input of this.db.stageEvents.listPendingTurnInputs(stageRunId)) {
      this.db.stageEvents.setPendingTurnInputRouting(input.id, threadId, turnId);
    }
  }

  async flush(
    stageRun: Pick<StageRunRecord, "id" | "threadId" | "turnId">,
    options?: {
      issueKey?: string;
      logFailures?: boolean;
      failureMessage?: string;
    },
  ): Promise<void> {
    if (!stageRun.threadId || !stageRun.turnId) {
      return;
    }

    for (const input of this.db.stageEvents.listPendingTurnInputs(stageRun.id)) {
      try {
        await this.codex.steerTurn({
          threadId: stageRun.threadId,
          turnId: stageRun.turnId,
          input: input.body,
        });
        this.db.stageEvents.markTurnInputDelivered(input.id);
      } catch (error) {
        if (options?.logFailures) {
          this.logger.warn(
            {
              issueKey: options.issueKey,
              threadId: stageRun.threadId,
              turnId: stageRun.turnId,
              queuedInputId: input.id,
              error: error instanceof Error ? error.message : String(error),
            },
            options.failureMessage ?? "Failed to deliver queued turn input",
          );
        }
        break;
      }
    }
  }
}
