import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { IssueControlStoreProvider, ObligationStoreProvider } from "./ledger-ports.ts";
import type { StageRunRecord } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";
import { safeJsonParse } from "./utils.ts";

export class StageTurnInputDispatcher {
  constructor(
    private readonly inputs: IssueControlStoreProvider & ObligationStoreProvider,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
  ) {}

  routePendingInputs(stageRun: Pick<StageRunRecord, "id" | "projectId" | "linearIssueId">, threadId: string, turnId: string): void {
    const issueControl = this.inputs.issueControl.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
      return;
    }

    for (const obligation of this.listPendingInputObligations(stageRun.projectId, stageRun.linearIssueId, issueControl.activeRunLeaseId)) {
      this.inputs.obligations.updateObligationRouting(obligation.id, {
        runLeaseId: issueControl.activeRunLeaseId,
        threadId,
        turnId,
      });
    }
  }

  async flush(
    stageRun: Pick<StageRunRecord, "id" | "projectId" | "linearIssueId" | "threadId" | "turnId">,
    options?: {
      issueKey?: string;
      logFailures?: boolean;
      failureMessage?: string;
      retryInProgress?: boolean;
    },
  ): Promise<{
    deliveredInputIds: number[];
    deliveredObligationIds: number[];
    deliveredCount: number;
    failedObligationIds: number[];
  }> {
    if (!stageRun.threadId || !stageRun.turnId) {
      return { deliveredInputIds: [], deliveredObligationIds: [], deliveredCount: 0, failedObligationIds: [] };
    }

    const issueControl = this.inputs.issueControl.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
      return { deliveredInputIds: [], deliveredObligationIds: [], deliveredCount: 0, failedObligationIds: [] };
    }

    const deliveredInputIds: number[] = [];
    const deliveredObligationIds: number[] = [];
    const failedObligationIds: number[] = [];
    let deliveredCount = 0;
    const obligationQuery = options?.retryInProgress ? { includeInProgress: true } : undefined;
    for (const obligation of this.listPendingInputObligations(
      stageRun.projectId,
      stageRun.linearIssueId,
      issueControl.activeRunLeaseId,
      obligationQuery,
    )) {
      const payload = safeJsonParse<{ body?: string }>(obligation.payloadJson);
      const body = payload?.body?.trim();
      if (!body) {
        this.inputs.obligations.markObligationStatus(obligation.id, "failed", "obligation payload had no deliverable body");
        continue;
      }

      const claimed =
        obligation.status === "in_progress" && options?.retryInProgress
          ? true
          : this.inputs.obligations.claimPendingObligation(obligation.id, {
              runLeaseId: issueControl.activeRunLeaseId,
              threadId: stageRun.threadId,
              turnId: stageRun.turnId,
            });
      if (!claimed) {
        continue;
      }

      try {
        if (obligation.status === "in_progress") {
          this.inputs.obligations.updateObligationRouting(obligation.id, {
            runLeaseId: issueControl.activeRunLeaseId,
            threadId: stageRun.threadId,
            turnId: stageRun.turnId,
          });
        }
        await this.codex.steerTurn({
          threadId: stageRun.threadId,
          turnId: stageRun.turnId,
          input: body,
        });
        deliveredObligationIds.push(obligation.id);
        this.inputs.obligations.markObligationStatus(obligation.id, "completed");
        deliveredCount += 1;
        this.logger.debug(
          {
            threadId: stageRun.threadId,
            turnId: stageRun.turnId,
            obligationId: obligation.id,
            source: obligation.source,
          },
          "Delivered queued turn input to Codex",
        );
      } catch (error) {
        this.inputs.obligations.markObligationStatus(obligation.id, "pending", error instanceof Error ? error.message : String(error));
        failedObligationIds.push(obligation.id);
        this.logger.warn(
          {
            issueKey: options?.issueKey,
            threadId: stageRun.threadId,
            turnId: stageRun.turnId,
            obligationId: obligation.id,
            source: obligation.source,
            error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
          },
          options?.failureMessage ?? "Failed to deliver queued turn input",
        );
        break;
      }
    }

    return { deliveredInputIds, deliveredObligationIds, deliveredCount, failedObligationIds };
  }

  private listPendingInputObligations(
    projectId: string,
    linearIssueId: string,
    activeRunLeaseId: number,
    options?: { includeInProgress?: boolean },
  ) {
    const query = options?.includeInProgress
      ? { kind: "deliver_turn_input", includeInProgress: true as const }
      : { kind: "deliver_turn_input" };
    return this.inputs.obligations
      .listPendingObligations(query)
      .filter(
        (obligation) =>
          obligation.projectId === projectId &&
          obligation.linearIssueId === linearIssueId &&
          (obligation.runLeaseId === undefined || obligation.runLeaseId === activeRunLeaseId),
      );
  }
}
