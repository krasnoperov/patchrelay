import type { Logger } from "pino";
import type { CodexNotification } from "./codex-app-server.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider, WorkspaceOwnershipStoreProvider } from "./ledger-ports.ts";
import type {
  StageEventLogStoreProvider,
  StageTurnInputStoreProvider,
} from "./stage-event-ports.ts";
import type {
  IssueWorkflowExecutionStoreProvider,
  IssueWorkflowLifecycleStoreProvider,
  IssueWorkflowQueryStoreProvider,
} from "./workflow-ports.ts";
import { syncFailedStageToLinear } from "./stage-failure.ts";
import {
  buildFailedStageReport,
  buildPendingMaterializationThread,
  buildStageReport,
  countEventMethods,
  extractStageSummary,
  extractTurnId,
  resolveStageRunStatus,
  summarizeCurrentThread,
} from "./stage-reporting.ts";
import { StageLifecyclePublisher } from "./stage-lifecycle-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { AppConfig, CodexThreadSummary, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

export class ServiceStageFinalizer {
  private readonly inputDispatcher: StageTurnInputDispatcher;
  private readonly lifecyclePublisher: StageLifecyclePublisher;

  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowExecutionStoreProvider &
      IssueWorkflowLifecycleStoreProvider &
      IssueWorkflowQueryStoreProvider &
      StageEventLogStoreProvider &
      StageTurnInputStoreProvider &
      Partial<IssueControlStoreProvider & ObligationStoreProvider & RunLeaseStoreProvider & WorkspaceOwnershipStoreProvider>,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    logger?: Logger,
  ) {
    const lifecycleLogger = logger ?? consoleLogger();
    this.inputDispatcher = new StageTurnInputDispatcher(stores, codex, lifecycleLogger);
    this.lifecyclePublisher = new StageLifecyclePublisher(config, stores, linearProvider, lifecycleLogger);
  }

  async getActiveStageStatus(issueKey: string) {
    const issue = this.stores.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue?.activeStageRunId) {
      return undefined;
    }

    const stageRun = this.stores.issueWorkflows.getStageRun(issue.activeStageRunId);
    if (!stageRun || !stageRun.threadId) {
      return undefined;
    }

    const thread = await this.codex.readThread(stageRun.threadId, true).catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      return buildPendingMaterializationThread(stageRun, err);
    });

    return {
      issue,
      stageRun,
      liveThread: summarizeCurrentThread(thread),
    };
  }

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) {
      return;
    }

    const stageRun = this.stores.issueWorkflows.getStageRunByThreadId(threadId);
    if (!stageRun) {
      return;
    }

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    if (this.config.runner.codex.persistExtendedHistory) {
      this.stores.stageEvents.saveThreadEvent({
        stageRunId: stageRun.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    if (notification.method === "turn/started" || notification.method.startsWith("item/")) {
      await this.flushQueuedTurnInputs(stageRun);
    }

    if (notification.method !== "turn/completed") {
      return;
    }

    const thread = await this.codex.readThread(threadId, true);
    const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (!issue) {
      return;
    }

    const completedTurnId = extractTurnId(notification.params);
    this.completeStageRun(stageRun, issue, thread, resolveStageRunStatus(notification.params), {
      threadId,
      ...(completedTurnId ? { turnId: completedTurnId } : {}),
    });
  }

  async reconcileActiveStageRuns(): Promise<void> {
    const activeStageRuns = this.stores.issueWorkflows.listActiveStageRuns();
    for (const stageRun of activeStageRuns) {
      if (!stageRun.threadId) {
        await this.failStageRunDuringReconciliation(
          stageRun,
          `missing-thread-${stageRun.id}`,
          "Stage run had no persisted thread id during reconciliation",
        );
        continue;
      }

      const thread = await this.codex.readThread(stageRun.threadId, true).catch(() => undefined);
      if (!thread) {
        await this.failStageRunDuringReconciliation(stageRun, stageRun.threadId, "Thread was not found during startup reconciliation", {
          ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
        });
        continue;
      }

      const latestTurn = thread.turns.at(-1);
      if (!latestTurn || latestTurn.status === "inProgress") {
        await this.deliverPendingObligations(stageRun.projectId, stageRun.linearIssueId, stageRun.threadId, latestTurn?.id ?? stageRun.turnId);
        continue;
      }

      const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
      if (!issue) {
        continue;
      }

      if (latestTurn.status !== "completed") {
        await this.failStageRunDuringReconciliation(stageRun, stageRun.threadId, "Thread completed reconciliation in a failed state", {
          ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
        });
        continue;
      }

      this.completeStageRun(stageRun, issue, thread, "completed", {
        threadId: stageRun.threadId,
        ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
      });
    }
  }

  private completeStageRun(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    thread: CodexThreadSummary,
    status: StageRunRecord["status"],
    params: { threadId: string; turnId?: string },
  ): void {
    const refreshedStageRun = this.stores.issueWorkflows.getStageRun(stageRun.id) ?? stageRun;
    const finalizedStageRun = {
      ...refreshedStageRun,
      status,
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
    };
    const report = buildStageReport(finalizedStageRun, issue, thread, countEventMethods(this.stores.stageEvents.listThreadEvents(stageRun.id)));

    this.stores.issueWorkflows.finishStageRun({
      stageRunId: stageRun.id,
      status,
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      summaryJson: JSON.stringify(extractStageSummary(report)),
      reportJson: JSON.stringify(report),
    });
    this.finishLedgerRun(stageRun.projectId, stageRun.linearIssueId, "completed", {
      threadId: params.threadId,
      ...(params.turnId ? { turnId: params.turnId } : {}),
      nextLifecycleStatus: issue.desiredStage ? "queued" : "completed",
    });

    void this.advanceAfterStageCompletion(stageRun);
  }

  private failStageRun(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): void {
    this.stores.issueWorkflows.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(
        buildFailedStageReport(stageRun, "failed", {
          threadId,
          ...(options?.turnId ? { turnId: options.turnId } : {}),
        }),
      ),
    });
    this.finishLedgerRun(stageRun.projectId, stageRun.linearIssueId, "failed", {
      threadId,
      ...(options?.turnId ? { turnId: options.turnId } : {}),
      failureReason: message,
      nextLifecycleStatus: "failed",
    });
  }

  private async failStageRunDuringReconciliation(
    stageRun: StageRunRecord,
    threadId: string,
    message: string,
    options?: {
      turnId?: string;
    },
  ): Promise<void> {
    this.failStageRun(stageRun, threadId, message, options);

    const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    if (!issue || !project) {
      return;
    }

    await syncFailedStageToLinear({
      stores: this.stores,
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: {
        ...stageRun,
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      },
      message,
      mode: "failed",
      requireActiveLinearStateMatch: true,
    });
  }

  async flushQueuedTurnInputs(stageRun: StageRunRecord): Promise<void> {
    await this.inputDispatcher.flush(stageRun);
  }

  private async advanceAfterStageCompletion(stageRun: StageRunRecord): Promise<void> {
    await this.lifecyclePublisher.publishStageCompletion(stageRun, this.enqueueIssue);
  }

  private finishLedgerRun(
    projectId: string,
    linearIssueId: string,
    status: "completed" | "failed",
    params: {
      threadId?: string;
      turnId?: string;
      failureReason?: string;
      nextLifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
    },
  ): void {
    const issueControl = this.stores.issueControl?.getIssueControl(projectId, linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
      return;
    }

    this.stores.runLeases?.finishRunLease({
      runLeaseId: issueControl.activeRunLeaseId,
      status,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(params.failureReason ? { failureReason: params.failureReason } : {}),
    });

    if (issueControl.activeWorkspaceOwnershipId !== undefined) {
      const workspace = this.stores.workspaceOwnership?.getWorkspaceOwnership(issueControl.activeWorkspaceOwnershipId);
      if (workspace) {
        this.stores.workspaceOwnership?.upsertWorkspaceOwnership({
          projectId,
          linearIssueId,
          branchName: workspace.branchName,
          worktreePath: workspace.worktreePath,
          status: status === "completed" ? "active" : "paused",
          currentRunLeaseId: null,
        });
      }
    }

    this.stores.issueControl?.upsertIssueControl({
      projectId,
      linearIssueId,
      activeRunLeaseId: null,
      ...(issueControl.activeWorkspaceOwnershipId !== undefined
        ? { activeWorkspaceOwnershipId: issueControl.activeWorkspaceOwnershipId }
        : {}),
      ...(issueControl.serviceOwnedCommentId ? { serviceOwnedCommentId: issueControl.serviceOwnedCommentId } : {}),
      ...(issueControl.activeAgentSessionId ? { activeAgentSessionId: issueControl.activeAgentSessionId } : {}),
      lifecycleStatus: params.nextLifecycleStatus,
    });
  }

  private async deliverPendingObligations(
    projectId: string,
    linearIssueId: string,
    threadId: string,
    turnId?: string,
  ): Promise<void> {
    if (!turnId) {
      return;
    }

    const issueControl = this.stores.issueControl?.getIssueControl(projectId, linearIssueId);
    if (!issueControl?.activeRunLeaseId || !this.stores.obligations) {
      return;
    }

    for (const obligation of this.stores.obligations.listPendingObligations({ runLeaseId: issueControl.activeRunLeaseId })) {
      this.stores.obligations.updateObligationRouting(obligation.id, { threadId, turnId });
      const payload = safeJsonParse<{ body?: string }>(obligation.payloadJson);
      const body = payload?.body?.trim();
      if (!body) {
        this.stores.obligations.markObligationStatus(obligation.id, "failed", "obligation payload had no deliverable body");
        continue;
      }

      try {
        await this.codex.steerTurn({ threadId, turnId, input: body });
        this.stores.obligations.markObligationStatus(obligation.id, "completed");
      } catch (error) {
        this.stores.obligations.markObligationStatus(
          obligation.id,
          "failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
}

function consoleLogger(): Logger {
  const noop = () => undefined;
  return {
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: () => consoleLogger(),
    level: "silent",
  } as unknown as Logger;
}
