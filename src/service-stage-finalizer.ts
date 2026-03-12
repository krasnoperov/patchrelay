import type { Logger } from "pino";
import type { CodexNotification } from "./codex-app-server.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider, WorkspaceOwnershipStoreProvider } from "./ledger-ports.ts";
import { ReconciliationActionApplier } from "./reconciliation-action-applier.ts";
import { reconcileIssue } from "./reconciliation-engine.ts";
import { buildReconciliationSnapshot } from "./reconciliation-snapshot-builder.ts";
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
  private readonly actionApplier: ReconciliationActionApplier;

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
    this.actionApplier = new ReconciliationActionApplier({
      enqueueIssue,
      deliverPendingObligations: (projectId, linearIssueId, threadId, turnId) =>
        this.deliverPendingObligations(projectId, linearIssueId, threadId, turnId),
      completeStageRun: (stageRun, issue, thread, status, params) => this.completeStageRun(stageRun, issue, thread, status, params),
      failStageRunDuringReconciliation: (stageRun, threadId, message, options) =>
        this.failStageRunDuringReconciliation(stageRun, threadId, message, options),
    });
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
    const activeRunLeases = this.stores.runLeases?.listActiveRunLeases().filter((runLease) => runLease.status === "running") ?? [];
    for (const runLease of activeRunLeases) {
      await this.reconcileRunLease(runLease.id);
    }
  }

  private completeStageRun(
    stageRun: StageRunRecord,
    issue: TrackedIssueRecord,
    thread: CodexThreadSummary,
    status: StageRunRecord["status"],
    params: { threadId: string; turnId?: string; nextLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"] },
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
      nextLifecycleStatus: params.nextLifecycleStatus ?? (issue.desiredStage ? "queued" : "completed"),
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
      const payload = safeJsonParse<{ body?: string; queuedInputId?: number; stageRunId?: number }>(obligation.payloadJson);
      const body = payload?.body?.trim();
      if (
        payload?.stageRunId !== undefined &&
        payload.queuedInputId !== undefined &&
        !this.stores.stageEvents.listPendingTurnInputs(payload.stageRunId).some((input) => input.id === payload.queuedInputId)
      ) {
        this.stores.obligations.markObligationStatus(obligation.id, "completed");
        continue;
      }
      if (!body) {
        this.stores.obligations.markObligationStatus(obligation.id, "failed", "obligation payload had no deliverable body");
        continue;
      }

      try {
        if (payload?.stageRunId !== undefined && payload.queuedInputId !== undefined) {
          this.stores.stageEvents.setPendingTurnInputRouting(payload.queuedInputId, threadId, turnId);
        }
        await this.codex.steerTurn({ threadId, turnId, input: body });
        if (payload?.queuedInputId !== undefined) {
          this.stores.stageEvents.markTurnInputDelivered(payload.queuedInputId);
        }
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

  private async reconcileRunLease(runLeaseId: number): Promise<void> {
    if (!this.stores.runLeases || !this.stores.issueControl) {
      return;
    }

    const snapshot = await buildReconciliationSnapshot({
      config: this.config,
      stores: {
        issueControl: this.stores.issueControl,
        runLeases: this.stores.runLeases,
        ...(this.stores.workspaceOwnership ? { workspaceOwnership: this.stores.workspaceOwnership } : {}),
        ...(this.stores.obligations ? { obligations: this.stores.obligations } : {}),
      },
      codex: this.codex,
      linearProvider: this.linearProvider,
      runLeaseId,
    });
    if (!snapshot) {
      return;
    }

    const runLease = snapshot.runLease;

    const stageRun =
      (runLease.threadId ? this.stores.issueWorkflows.getStageRunByThreadId(runLease.threadId) : undefined) ??
      this.stores.issueWorkflows.getLatestStageRunForIssue(runLease.projectId, runLease.linearIssueId);
    if (!stageRun) {
      return;
    }

    const decision = reconcileIssue(snapshot.input);

    if (decision.outcome === "hydrate_live_state") {
      return;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(runLease.projectId, runLease.linearIssueId);
    await this.actionApplier.apply({
      snapshot,
      decision,
      stageRun,
      ...(issue ? { issue } : {}),
    });
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
