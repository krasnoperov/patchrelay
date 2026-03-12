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
import type { AppConfig, CodexThreadSummary, LinearClientProvider, StageRunRecord, TrackedIssueRecord, WorkspaceRecord } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

export class ServiceStageFinalizer {
  private readonly inputDispatcher: StageTurnInputDispatcher;
  private readonly lifecyclePublisher: StageLifecyclePublisher;
  private readonly actionApplier: ReconciliationActionApplier;
  private readonly runAtomically: <T>(fn: () => T) => T;

  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowExecutionStoreProvider &
      IssueWorkflowLifecycleStoreProvider &
      IssueWorkflowQueryStoreProvider &
      StageEventLogStoreProvider &
      StageTurnInputStoreProvider &
      IssueControlStoreProvider &
      ObligationStoreProvider &
      RunLeaseStoreProvider &
      WorkspaceOwnershipStoreProvider,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    logger?: Logger,
    runAtomically: <T>(fn: () => T) => T = (fn) => fn(),
  ) {
    this.runAtomically = runAtomically;
    const lifecycleLogger = logger ?? consoleLogger();
    this.inputDispatcher = new StageTurnInputDispatcher(stores, codex, lifecycleLogger);
    this.lifecyclePublisher = new StageLifecyclePublisher(config, stores, linearProvider, lifecycleLogger);
    this.actionApplier = new ReconciliationActionApplier({
      enqueueIssue,
      deliverPendingObligations: (projectId, linearIssueId, threadId, turnId) =>
        this.deliverPendingObligations(projectId, linearIssueId, threadId, turnId),
      completeRun: (projectId, linearIssueId, thread, params) =>
        this.completeReconciledRun(projectId, linearIssueId, thread, params),
      failRunDuringReconciliation: (projectId, linearIssueId, threadId, message, options) =>
        this.failRunLeaseDuringReconciliation(projectId, linearIssueId, threadId, message, options),
    });
  }

  async getActiveStageStatus(issueKey: string) {
    const issue = this.stores.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.resolveActiveStageRun(issue);
    if (!stageRun?.threadId) {
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
    const runLeaseIds = [
      ...this.adoptLegacyRunningStages(),
      ...this.stores.runLeases.listActiveRunLeases().filter((runLease) => runLease.status === "running").map((runLease) => runLease.id),
    ];
    for (const runLeaseId of new Set(runLeaseIds)) {
      await this.reconcileRunLease(runLeaseId);
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

    this.runAtomically(() => {
      this.finishLedgerRun(stageRun.projectId, stageRun.linearIssueId, "completed", {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        nextLifecycleStatus: params.nextLifecycleStatus ?? (issue.desiredStage ? "queued" : "completed"),
      });
      this.stores.issueWorkflows.finishStageRun({
        stageRunId: stageRun.id,
        status,
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        summaryJson: JSON.stringify(extractStageSummary(report)),
        reportJson: JSON.stringify(report),
      });
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
    this.runAtomically(() => {
      this.finishLedgerRun(stageRun.projectId, stageRun.linearIssueId, "failed", {
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        failureReason: message,
        nextLifecycleStatus: "failed",
      });
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
    const issueControl = this.stores.issueControl.getIssueControl(projectId, linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
      return;
    }

    this.stores.runLeases.finishRunLease({
      runLeaseId: issueControl.activeRunLeaseId,
      status,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.turnId ? { turnId: params.turnId } : {}),
      ...(params.failureReason ? { failureReason: params.failureReason } : {}),
    });

    if (issueControl.activeWorkspaceOwnershipId !== undefined) {
      const workspace = this.stores.workspaceOwnership.getWorkspaceOwnership(issueControl.activeWorkspaceOwnershipId);
      if (workspace) {
        this.stores.workspaceOwnership.upsertWorkspaceOwnership({
          projectId,
          linearIssueId,
          branchName: workspace.branchName,
          worktreePath: workspace.worktreePath,
          status: status === "completed" ? "active" : "paused",
          currentRunLeaseId: null,
        });
      }
    }

    this.stores.issueControl.upsertIssueControl({
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

    const issueControl = this.stores.issueControl.getIssueControl(projectId, linearIssueId);
    if (!issueControl?.activeRunLeaseId) {
      return;
    }

    for (const obligation of this.stores.obligations.listPendingObligations({
      runLeaseId: issueControl.activeRunLeaseId,
      kind: "deliver_turn_input",
    })) {
      this.stores.obligations.updateObligationRouting(obligation.id, { threadId, turnId });
      const payload = safeJsonParse<{ body?: string; queuedInputId?: number; stageRunId?: number }>(obligation.payloadJson);
      const body = payload?.body?.trim();
      if (!body) {
        this.stores.obligations.markObligationStatus(obligation.id, "failed", "obligation payload had no deliverable body");
        continue;
      }

      try {
        this.stores.obligations.markObligationStatus(obligation.id, "in_progress");
        const mirroredQueuedInput =
          payload?.stageRunId !== undefined
            ? this.stores.stageEvents.listPendingTurnInputs(payload.stageRunId).find((input) =>
                payload.queuedInputId !== undefined ? input.id === payload.queuedInputId : input.source === obligation.source && input.body === body,
              )
            : undefined;
        if (mirroredQueuedInput) {
          this.stores.stageEvents.setPendingTurnInputRouting(mirroredQueuedInput.id, threadId, turnId);
        }
        await this.codex.steerTurn({ threadId, turnId, input: body });
        if (mirroredQueuedInput) {
          this.stores.stageEvents.markTurnInputDelivered(mirroredQueuedInput.id);
        }
        this.stores.obligations.markObligationStatus(obligation.id, "completed");
      } catch (error) {
        this.stores.obligations.markObligationStatus(
          obligation.id,
          "pending",
          error instanceof Error ? error.message : String(error),
        );
        break;
      }
    }
  }

  private adoptLegacyRunningStages(): number[] {
    const adoptedRunLeaseIds: number[] = [];
    for (const stageRun of this.stores.issueWorkflows.listActiveStageRuns()) {
      const issue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
      if (!issue) {
        continue;
      }

      const existingControl = this.stores.issueControl.getIssueControl(stageRun.projectId, stageRun.linearIssueId);
      if (existingControl?.activeRunLeaseId !== undefined) {
        continue;
      }
      if (existingControl && existingControl.lifecycleStatus !== "running") {
        continue;
      }

      const workspace = this.stores.issueWorkflows.getWorkspace(stageRun.workspaceId);
      if (!workspace) {
        continue;
      }

      adoptedRunLeaseIds.push(this.adoptLegacyStageRun(issue, stageRun, workspace));
    }

    return adoptedRunLeaseIds;
  }

  private adoptLegacyStageRun(issue: TrackedIssueRecord, stageRun: StageRunRecord, workspace: WorkspaceRecord): number {
    const workspaceOwnership = this.stores.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      status: "active",
    });
    const issueControl = this.stores.issueControl.upsertIssueControl({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      desiredStage: null,
      desiredReceiptId: null,
      activeWorkspaceOwnershipId: workspaceOwnership.id,
      ...(issue.statusCommentId ? { serviceOwnedCommentId: issue.statusCommentId } : {}),
      ...(issue.activeAgentSessionId ? { activeAgentSessionId: issue.activeAgentSessionId } : {}),
      lifecycleStatus: "running",
    });
    const runLease = this.stores.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      workspaceOwnershipId: workspaceOwnership.id,
      stage: stageRun.stage,
      status: "running",
    });

    if (stageRun.threadId || stageRun.turnId || stageRun.parentThreadId) {
      this.stores.runLeases.updateRunLeaseThread({
        runLeaseId: runLease.id,
        ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
        ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
        ...(stageRun.parentThreadId ? { parentThreadId: stageRun.parentThreadId } : {}),
      });
    }

    this.stores.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      status: "active",
      currentRunLeaseId: runLease.id,
    });
    this.stores.issueControl.upsertIssueControl({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      desiredStage: null,
      desiredReceiptId: null,
      activeWorkspaceOwnershipId: workspaceOwnership.id,
      activeRunLeaseId: runLease.id,
      ...(issue.statusCommentId ? { serviceOwnedCommentId: issue.statusCommentId } : {}),
      ...(issue.activeAgentSessionId ? { activeAgentSessionId: issue.activeAgentSessionId } : {}),
      lifecycleStatus: "running",
    });
    return runLease.id;
  }

  private async reconcileRunLease(runLeaseId: number): Promise<void> {
    const snapshot = await buildReconciliationSnapshot({
      config: this.config,
      stores: {
        issueControl: this.stores.issueControl,
        runLeases: this.stores.runLeases,
        workspaceOwnership: this.stores.workspaceOwnership,
        obligations: this.stores.obligations,
      },
      codex: this.codex,
      linearProvider: this.linearProvider,
      runLeaseId,
    });
    if (!snapshot) {
      return;
    }
    const decision = reconcileIssue(snapshot.input);

    if (decision.outcome === "hydrate_live_state") {
      return;
    }

    await this.actionApplier.apply({
      snapshot,
      decision,
    });
  }

  private completeReconciledRun(
    projectId: string,
    linearIssueId: string,
    thread: CodexThreadSummary,
    params: { threadId: string; turnId?: string; nextLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"] },
  ): void {
    const stageRun = this.findLegacyStageRunForIssue(projectId, linearIssueId, params.threadId);
    const issue = this.stores.issueWorkflows.getTrackedIssue(projectId, linearIssueId);
    if (!stageRun || !issue) {
      this.finishLedgerRun(projectId, linearIssueId, "completed", {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        nextLifecycleStatus: params.nextLifecycleStatus ?? "completed",
      });
      return;
    }
    this.completeStageRun(stageRun, issue, thread, "completed", params);
  }

  private async failRunLeaseDuringReconciliation(
    projectId: string,
    linearIssueId: string,
    threadId: string,
    message: string,
    options?: { turnId?: string },
  ): Promise<void> {
    const stageRun = this.findLegacyStageRunForIssue(projectId, linearIssueId, threadId);
    if (!stageRun) {
      this.finishLedgerRun(projectId, linearIssueId, "failed", {
        threadId,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
        failureReason: message,
        nextLifecycleStatus: "failed",
      });
      return;
    }
    await this.failStageRunDuringReconciliation(stageRun, threadId, message, options);
  }

  private findLegacyStageRunForIssue(projectId: string, linearIssueId: string, threadId?: string): StageRunRecord | undefined {
    return (threadId ? this.stores.issueWorkflows.getStageRunByThreadId(threadId) : undefined) ??
      this.stores.issueWorkflows.getLatestStageRunForIssue(projectId, linearIssueId);
  }

  private resolveActiveStageRun(issue: TrackedIssueRecord): StageRunRecord | undefined {
    const directStageRun =
      this.resolveLedgerMirroredStageRun(issue.projectId, issue.linearIssueId) ??
      (issue.activeStageRunId ? this.stores.issueWorkflows.getStageRun(issue.activeStageRunId) : undefined);
    if (directStageRun) {
      return directStageRun.projectId === issue.projectId && directStageRun.linearIssueId === issue.linearIssueId
        ? directStageRun
        : undefined;
    }

    const issueControl = this.stores.issueControl.getIssueControl(issue.projectId, issue.linearIssueId);
    const runLease = issueControl?.activeRunLeaseId ? this.stores.runLeases.getRunLease(issueControl.activeRunLeaseId) : undefined;
    if (!runLease) {
      return undefined;
    }

    return {
      id: -runLease.id,
      pipelineRunId: 0,
      projectId: runLease.projectId,
      linearIssueId: runLease.linearIssueId,
      workspaceId: 0,
      stage: runLease.stage,
      status: runLease.status === "failed" ? "failed" : runLease.status === "completed" ? "completed" : "running",
      triggerWebhookId: "ledger-active-run",
      workflowFile: "",
      promptText: "",
      ...(runLease.threadId ? { threadId: runLease.threadId } : {}),
      ...(runLease.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
      ...(runLease.turnId ? { turnId: runLease.turnId } : {}),
      startedAt: runLease.startedAt,
      ...(runLease.endedAt ? { endedAt: runLease.endedAt } : {}),
    };
  }

  private resolveLedgerMirroredStageRun(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    const issueControl = this.stores.issueControl.getIssueControl(projectId, linearIssueId);
    const runLease = issueControl?.activeRunLeaseId ? this.stores.runLeases.getRunLease(issueControl.activeRunLeaseId) : undefined;
    return runLease?.threadId ? this.stores.issueWorkflows.getStageRunByThreadId(runLease.threadId) : undefined;
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
