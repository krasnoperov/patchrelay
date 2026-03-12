import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { StageRunRecord } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

export class StageTurnInputDispatcher {
  constructor(
    private readonly inputs: StageTurnInputStoreProvider,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
  ) {}

  routePendingInputs(stageRunId: number, threadId: string, turnId: string): void {
    for (const input of this.inputs.stageEvents.listPendingTurnInputs(stageRunId)) {
      this.inputs.stageEvents.setPendingTurnInputRouting(input.id, threadId, turnId);
    }
  }

  async flush(
    stageRun: Pick<StageRunRecord, "id" | "threadId" | "turnId">,
    options?: {
      issueKey?: string;
      logFailures?: boolean;
      failureMessage?: string;
    },
  ): Promise<{ deliveredInputIds: number[] }> {
    if (!stageRun.threadId || !stageRun.turnId) {
      return { deliveredInputIds: [] };
    }

    const deliveredInputIds: number[] = [];
    for (const input of this.inputs.stageEvents.listPendingTurnInputs(stageRun.id)) {
      try {
        await this.codex.steerTurn({
          threadId: stageRun.threadId,
          turnId: stageRun.turnId,
          input: input.body,
        });
        this.inputs.stageEvents.markTurnInputDelivered(input.id);
        deliveredInputIds.push(input.id);
        this.logger.debug(
          {
            threadId: stageRun.threadId,
            turnId: stageRun.turnId,
            queuedInputId: input.id,
            source: input.source,
          },
          "Delivered queued turn input to Codex",
        );
      } catch (error) {
        this.logger.warn(
          {
            issueKey: options?.issueKey,
            threadId: stageRun.threadId,
            turnId: stageRun.turnId,
            queuedInputId: input.id,
            source: input.source,
            error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
          },
          options?.failureMessage ?? "Failed to deliver queued turn input",
        );
        break;
      }
    }

    return { deliveredInputIds };
  }
}
