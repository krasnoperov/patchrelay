import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { IssueControlStoreProvider, ObligationStoreProvider } from "./ledger-ports.ts";
import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { StageRunRecord } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";
import { safeJsonParse } from "./utils.ts";

export class StageTurnInputDispatcher {
  constructor(
    private readonly inputs: StageTurnInputStoreProvider & Partial<IssueControlStoreProvider & ObligationStoreProvider>,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
  ) {}

  routePendingInputs(stageRun: Pick<StageRunRecord, "id" | "projectId" | "linearIssueId">, threadId: string, turnId: string): void {
    for (const input of this.inputs.stageEvents.listPendingTurnInputs(stageRun.id)) {
      this.inputs.stageEvents.setPendingTurnInputRouting(input.id, threadId, turnId);
    }

    const issueControl = this.inputs.issueControl?.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
    if (!issueControl?.activeRunLeaseId || !this.inputs.obligations) {
      return;
    }

    for (const obligation of this.inputs.obligations.listPendingObligations({ runLeaseId: issueControl.activeRunLeaseId, kind: "deliver_turn_input" })) {
      this.inputs.obligations.updateObligationRouting(obligation.id, { threadId, turnId });
    }
  }

  async flush(
    stageRun: Pick<StageRunRecord, "id" | "projectId" | "linearIssueId" | "threadId" | "turnId">,
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
    const inputs = this.listPendingInputs(stageRun);
    for (const input of inputs) {
      try {
        await this.codex.steerTurn({
          threadId: stageRun.threadId,
          turnId: stageRun.turnId,
          input: input.body,
        });
        if (input.kind === "obligation") {
          if (input.queuedInputId !== undefined) {
            this.inputs.stageEvents.markTurnInputDelivered(input.queuedInputId);
            deliveredInputIds.push(input.queuedInputId);
          }
          this.inputs.obligations?.markObligationStatus(input.id, "completed");
        } else {
          this.inputs.stageEvents.markTurnInputDelivered(input.id);
          deliveredInputIds.push(input.id);
        }
        this.logger.debug(
          {
            threadId: stageRun.threadId,
            turnId: stageRun.turnId,
            queuedInputId: input.kind === "obligation" ? input.queuedInputId : input.id,
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
            queuedInputId: input.kind === "obligation" ? input.queuedInputId : input.id,
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

  private listPendingInputs(stageRun: Pick<StageRunRecord, "id" | "projectId" | "linearIssueId">) {
    const ledgerInputs = this.listPendingObligationInputs(stageRun);
    if (ledgerInputs !== undefined) {
      return ledgerInputs;
    }

    return this.inputs.stageEvents.listPendingTurnInputs(stageRun.id).map((input) => ({
      kind: "legacy" as const,
      id: input.id,
      source: input.source,
      body: input.body,
    }));
  }

  private listPendingObligationInputs(stageRun: Pick<StageRunRecord, "projectId" | "linearIssueId">) {
    const issueControl = this.inputs.issueControl?.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
    if (!issueControl?.activeRunLeaseId || !this.inputs.obligations) {
      return undefined;
    }

    return this.inputs.obligations
      .listPendingObligations({ runLeaseId: issueControl.activeRunLeaseId, kind: "deliver_turn_input" })
      .flatMap((obligation) => {
        const payload = safeJsonParse<{ body?: string; queuedInputId?: number }>(obligation.payloadJson);
        const body = payload?.body?.trim();
        if (!body) {
          return [];
        }
        return [
          {
            kind: "obligation" as const,
            id: obligation.id,
            source: obligation.source,
            body,
            ...(payload?.queuedInputId !== undefined ? { queuedInputId: payload.queuedInputId } : {}),
          },
        ];
      });
  }
}
