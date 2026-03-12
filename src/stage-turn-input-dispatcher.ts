import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { IssueControlStoreProvider, ObligationStoreProvider } from "./ledger-ports.ts";
import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { StageRunRecord } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";
import { safeJsonParse } from "./utils.ts";

export class StageTurnInputDispatcher {
  constructor(
    private readonly inputs: StageTurnInputStoreProvider & IssueControlStoreProvider & ObligationStoreProvider,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
  ) {}

  routePendingInputs(stageRun: Pick<StageRunRecord, "id" | "projectId" | "linearIssueId">, threadId: string, turnId: string): void {
    for (const input of this.inputs.stageEvents.listPendingTurnInputs(stageRun.id)) {
      this.inputs.stageEvents.setPendingTurnInputRouting(input.id, threadId, turnId);
    }

    const issueControl = this.inputs.issueControl.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
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
  ): Promise<{ deliveredInputIds: number[]; deliveredObligationIds: number[]; deliveredCount: number }> {
    if (!stageRun.threadId || !stageRun.turnId) {
      return { deliveredInputIds: [], deliveredObligationIds: [], deliveredCount: 0 };
    }

    const deliveredInputIds: number[] = [];
    const deliveredObligationIds: number[] = [];
    let deliveredCount = 0;
    const inputs = this.listPendingInputs(stageRun);
    for (const input of inputs) {
      try {
        await this.codex.steerTurn({
          threadId: stageRun.threadId,
          turnId: stageRun.turnId,
          input: input.body,
        });
        if (input.kind === "obligation") {
          deliveredObligationIds.push(input.id);
          const mirroredQueuedInputId =
            input.queuedInputId ?? this.findMirroredQueuedInputId(input.stageRunId, input.source, input.body);
          if (mirroredQueuedInputId !== undefined) {
            this.inputs.stageEvents.markTurnInputDelivered(mirroredQueuedInputId);
            deliveredInputIds.push(mirroredQueuedInputId);
          }
          this.inputs.obligations.markObligationStatus(input.id, "completed");
        } else {
          this.inputs.stageEvents.markTurnInputDelivered(input.id);
          deliveredInputIds.push(input.id);
        }
        deliveredCount += 1;
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

    return { deliveredInputIds, deliveredObligationIds, deliveredCount };
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
    const issueControl = this.inputs.issueControl.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
      return undefined;
    }

    return this.inputs.obligations
      .listPendingObligations({ runLeaseId: issueControl.activeRunLeaseId, kind: "deliver_turn_input" })
      .flatMap((obligation) => {
        const payload = safeJsonParse<{ body?: string; queuedInputId?: number; stageRunId?: number }>(obligation.payloadJson);
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
            ...(payload?.stageRunId !== undefined ? { stageRunId: payload.stageRunId } : {}),
          },
        ];
      });
  }

  private findMirroredQueuedInputId(stageRunId: number | undefined, source: string, body: string): number | undefined {
    if (stageRunId === undefined) {
      return undefined;
    }

    return this.inputs.stageEvents
      .listPendingTurnInputs(stageRunId)
      .find((input) => input.source === source && input.body === body)?.id;
  }
}
