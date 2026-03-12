import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type {
  EventReceiptStoreProvider,
  IssueControlStoreProvider,
  ObligationStoreProvider,
  RunLeaseStoreProvider,
  WorkspaceOwnershipStoreProvider,
} from "./ledger-ports.ts";
import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowExecutionStoreProvider, IssueWorkflowLifecycleStoreProvider } from "./workflow-ports.ts";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.ts";
import { syncFailedStageToLinear } from "./stage-failure.ts";
import { buildFailedStageReport } from "./stage-reporting.ts";
import { StageLifecyclePublisher } from "./stage-lifecycle-publisher.ts";
import { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import type { AppConfig, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { WorktreeManager } from "./worktree-manager.ts";

export interface IssueQueueItem {
  projectId: string;
  issueId: string;
}

export class ServiceStageRunner {
  private readonly worktreeManager: WorktreeManager;
  private readonly inputDispatcher: StageTurnInputDispatcher;
  private readonly lifecyclePublisher: StageLifecyclePublisher;

  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowExecutionStoreProvider &
      IssueWorkflowLifecycleStoreProvider &
      StageTurnInputStoreProvider &
      Partial<
        EventReceiptStoreProvider &
          IssueControlStoreProvider &
          ObligationStoreProvider &
          WorkspaceOwnershipStoreProvider &
          RunLeaseStoreProvider
      >,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {
    this.worktreeManager = new WorktreeManager(config);
    this.inputDispatcher = new StageTurnInputDispatcher(stores, codex, logger);
    this.lifecyclePublisher = new StageLifecyclePublisher(config, stores, linearProvider, logger);
  }

  async run(item: IssueQueueItem): Promise<void> {
    const project = this.config.projects.find((candidate) => candidate.id === item.projectId);
    if (!project) {
      return;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(item.projectId, item.issueId);
    const issueControl = this.resolveLaunchIssueControl(item.projectId, item.issueId, issue);
    if (!issue || !issueControl?.desiredStage || issueControl.activeRunLeaseId !== undefined) {
      return;
    }

    const receipt =
      issueControl.desiredReceiptId !== undefined ? this.stores.eventReceipts?.getEventReceipt(issueControl.desiredReceiptId) : undefined;
    if (!receipt?.externalId) {
      return;
    }
    const desiredStage = issueControl.desiredStage;
    const desiredWebhookId = receipt.externalId;

    const plan = buildStageLaunchPlan(project, issue, desiredStage);
    const claim = this.stores.issueWorkflows.claimStageRun({
      projectId: item.projectId,
      linearIssueId: item.issueId,
      stage: desiredStage,
      triggerWebhookId: desiredWebhookId,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      workflowFile: plan.workflowFile,
      promptText: plan.prompt,
    });
    if (!claim) {
      return;
    }

    let threadLaunch;
    let turn;
    const runLeaseId = this.beginRunLease(claim);
    try {
      await this.worktreeManager.ensureIssueWorktree(project.repoPath, project.worktreeRoot, plan.worktreePath, plan.branchName);
      await this.lifecyclePublisher.markStageActive(project, claim.issue, claim.stageRun);

      threadLaunch = await this.launchStageThread(item.projectId, item.issueId, claim.stageRun.id, plan.worktreePath, issue.issueKey);
      turn = await this.codex.startTurn({
        threadId: threadLaunch.threadId,
        cwd: plan.worktreePath,
        input: plan.prompt,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.markLaunchFailed(project, claim.issue, claim.stageRun, err.message, threadLaunch?.threadId);
      this.logger.error(
        {
          issueKey: issue.issueKey,
          stage: claim.stageRun.stage,
          worktreePath: plan.worktreePath,
          branchName: plan.branchName,
          error: err.message,
          stack: err.stack,
        },
        "Failed to launch Codex stage run",
      );
      throw err;
    }

    this.stores.issueWorkflows.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: threadLaunch.threadId,
      ...(threadLaunch.parentThreadId ? { parentThreadId: threadLaunch.parentThreadId } : {}),
      turnId: turn.turnId,
    });
    if (runLeaseId !== undefined) {
      this.stores.runLeases?.updateRunLeaseThread({
        runLeaseId,
        threadId: threadLaunch.threadId,
        ...(threadLaunch.parentThreadId ? { parentThreadId: threadLaunch.parentThreadId } : {}),
        turnId: turn.turnId,
      });
    }

    this.inputDispatcher.routePendingInputs(claim.stageRun, threadLaunch.threadId, turn.turnId);
    const pendingLaunchInput = this.stores.issueWorkflows.consumeIssuePendingLaunchInput(item.projectId, item.issueId);
    if (pendingLaunchInput) {
      const mirroredQueuedInputId = this.stores.stageEvents.enqueueTurnInput({
        stageRunId: claim.stageRun.id,
        threadId: threadLaunch.threadId,
        turnId: turn.turnId,
        source: "linear-agent-launch",
        body: pendingLaunchInput,
      });
      const issueControl = this.stores.issueControl?.getIssueControl(item.projectId, item.issueId);
      if (issueControl?.activeRunLeaseId !== undefined && this.stores.obligations) {
        this.stores.obligations.enqueueObligation({
          projectId: item.projectId,
          linearIssueId: item.issueId,
          kind: "deliver_turn_input",
          source: "linear-agent-launch",
          payloadJson: JSON.stringify({
            body: pendingLaunchInput,
            queuedInputId: mirroredQueuedInputId,
            stageRunId: claim.stageRun.id,
          }),
          runLeaseId: issueControl.activeRunLeaseId,
          threadId: threadLaunch.threadId,
          turnId: turn.turnId,
          dedupeKey: `linear-agent-launch:${claim.stageRun.id}:${mirroredQueuedInputId}`,
        });
      }
    }
    await this.inputDispatcher.flush(
      {
        id: claim.stageRun.id,
        projectId: claim.stageRun.projectId,
        linearIssueId: claim.stageRun.linearIssueId,
        threadId: threadLaunch.threadId,
        turnId: turn.turnId,
      },
      {
        logFailures: true,
        failureMessage: "Failed to deliver queued Linear comment during stage startup",
        ...(claim.issue.issueKey ? { issueKey: claim.issue.issueKey } : {}),
      },
    );
    await this.lifecyclePublisher.refreshRunningStatusComment(item.projectId, item.issueId, claim.stageRun.id, issue.issueKey);
    await this.lifecyclePublisher.publishStageStarted(claim.issue, claim.stageRun.stage);

    this.logger.info(
      {
        issueKey: issue.issueKey,
        stage: claim.stageRun.stage,
        worktreePath: plan.worktreePath,
        branchName: plan.branchName,
        threadId: threadLaunch.threadId,
        turnId: turn.turnId,
      },
      "Started Codex stage run",
    );
  }

  private async launchStageThread(
    projectId: string,
    issueId: string,
    stageRunId: number,
    worktreePath: string,
    issueKey?: string,
  ): Promise<{ threadId: string; parentThreadId?: string }> {
    const previousStageRun = this.stores.issueWorkflows
      .listStageRunsForIssue(projectId, issueId)
      .filter((stageRun) => stageRun.id !== stageRunId)
      .at(-1);
    const parentThreadId =
      previousStageRun?.status === "completed" && isCodexThreadId(previousStageRun.threadId)
        ? previousStageRun.threadId
        : undefined;

    if (parentThreadId) {
      try {
        const thread = await this.codex.forkThread(parentThreadId, worktreePath);
        return {
          threadId: thread.id,
          parentThreadId,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn(
          {
            issueKey,
            parentThreadId,
            error: err.message,
          },
          "Falling back to a fresh Codex thread after parent thread fork failed",
        );
      }
    }

    const thread = await this.codex.startThread({ cwd: worktreePath });
    return {
      threadId: thread.id,
    };
  }

  private async markLaunchFailed(
    project: AppConfig["projects"][number],
    issue: TrackedIssueRecord,
    stageRun: StageRunRecord,
    message: string,
    threadId?: string,
  ): Promise<void> {
    const failureThreadId = threadId ?? `launch-failed-${stageRun.id}`;
    this.stores.issueWorkflows.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId: failureThreadId,
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId: failureThreadId })),
    });
    this.finishRunLease(stageRun.projectId, stageRun.linearIssueId, "failed", {
      threadId: failureThreadId,
      failureReason: message,
    });

    await syncFailedStageToLinear({
      stores: this.stores,
      linearProvider: this.linearProvider,
      project,
      issue,
      stageRun: {
        ...stageRun,
        threadId: failureThreadId,
      },
      message,
      mode: "launch",
    });
  }

  private beginRunLease(
    claim: { issue: TrackedIssueRecord; workspace: { branchName: string; worktreePath: string }; stageRun: StageRunRecord },
  ): number | undefined {
    if (!this.stores.issueControl || !this.stores.workspaceOwnership || !this.stores.runLeases) {
      return undefined;
    }

    const existingIssueControl = this.stores.issueControl.getIssueControl(claim.issue.projectId, claim.issue.linearIssueId);
    const receiptId = existingIssueControl?.desiredReceiptId;
    const issueControl = this.stores.issueControl.upsertIssueControl({
      projectId: claim.issue.projectId,
      linearIssueId: claim.issue.linearIssueId,
      desiredStage: null,
      ...(receiptId !== undefined ? { desiredReceiptId: null } : {}),
      ...(claim.issue.statusCommentId ? { serviceOwnedCommentId: claim.issue.statusCommentId } : {}),
      ...(claim.issue.activeAgentSessionId ? { activeAgentSessionId: claim.issue.activeAgentSessionId } : {}),
      lifecycleStatus: "running",
    });
    const workspaceOwnership = this.stores.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: claim.issue.projectId,
      linearIssueId: claim.issue.linearIssueId,
      branchName: claim.workspace.branchName,
      worktreePath: claim.workspace.worktreePath,
      status: "active",
    });
    const runLease = this.stores.runLeases.createRunLease({
      issueControlId: issueControl.id,
      projectId: claim.issue.projectId,
      linearIssueId: claim.issue.linearIssueId,
      workspaceOwnershipId: workspaceOwnership.id,
      stage: claim.stageRun.stage,
      ...(receiptId !== undefined ? { triggerReceiptId: receiptId } : {}),
      status: "running",
    });
    this.stores.workspaceOwnership.upsertWorkspaceOwnership({
      projectId: claim.issue.projectId,
      linearIssueId: claim.issue.linearIssueId,
      branchName: claim.workspace.branchName,
      worktreePath: claim.workspace.worktreePath,
      status: "active",
      currentRunLeaseId: runLease.id,
    });
    this.stores.issueControl.upsertIssueControl({
      projectId: claim.issue.projectId,
      linearIssueId: claim.issue.linearIssueId,
      desiredStage: null,
      desiredReceiptId: null,
      activeWorkspaceOwnershipId: workspaceOwnership.id,
      activeRunLeaseId: runLease.id,
      ...(claim.issue.statusCommentId ? { serviceOwnedCommentId: claim.issue.statusCommentId } : {}),
      ...(claim.issue.activeAgentSessionId ? { activeAgentSessionId: claim.issue.activeAgentSessionId } : {}),
      lifecycleStatus: "running",
    });
    return runLease.id;
  }

  private resolveLaunchIssueControl(
    projectId: string,
    linearIssueId: string,
    issue: TrackedIssueRecord | undefined,
  ) {
    const existingIssueControl = this.stores.issueControl?.getIssueControl(projectId, linearIssueId);
    if (!issue?.desiredStage || !issue.desiredWebhookId || !this.stores.issueControl) {
      return existingIssueControl;
    }

    const existingReceipt = this.stores.eventReceipts?.getEventReceiptBySourceExternalId("linear-webhook", issue.desiredWebhookId);
    const insertedReceipt =
      existingReceipt ??
      this.stores.eventReceipts?.insertEventReceipt({
        source: "linear-webhook",
        externalId: issue.desiredWebhookId,
        eventType: "legacy-launch-intent",
        receivedAt: new Date().toISOString(),
        acceptanceStatus: "accepted",
        projectId,
        linearIssueId,
      });
    const receiptId = insertedReceipt?.id;

    return this.stores.issueControl.upsertIssueControl({
      projectId,
      linearIssueId,
      ...(existingIssueControl?.desiredStage ? { desiredStage: existingIssueControl.desiredStage } : { desiredStage: issue.desiredStage }),
      ...(receiptId !== undefined ? { desiredReceiptId: receiptId } : {}),
      ...(existingIssueControl?.activeWorkspaceOwnershipId !== undefined
        ? { activeWorkspaceOwnershipId: existingIssueControl.activeWorkspaceOwnershipId }
        : {}),
      ...(existingIssueControl?.activeRunLeaseId !== undefined ? { activeRunLeaseId: existingIssueControl.activeRunLeaseId } : {}),
      ...(issue.statusCommentId
        ? { serviceOwnedCommentId: issue.statusCommentId }
        : existingIssueControl?.serviceOwnedCommentId
          ? { serviceOwnedCommentId: existingIssueControl.serviceOwnedCommentId }
          : {}),
      ...(issue.activeAgentSessionId
        ? { activeAgentSessionId: issue.activeAgentSessionId }
        : existingIssueControl?.activeAgentSessionId
          ? { activeAgentSessionId: existingIssueControl.activeAgentSessionId }
          : {}),
      lifecycleStatus: existingIssueControl?.lifecycleStatus ?? issue.lifecycleStatus,
    });
  }

  private finishRunLease(
    projectId: string,
    linearIssueId: string,
    status: "failed",
    params: { threadId?: string; turnId?: string; failureReason?: string },
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
          status: "paused",
          currentRunLeaseId: null,
        });
      }
    }
    this.stores.issueControl?.upsertIssueControl({
      projectId,
      linearIssueId,
      activeRunLeaseId: null,
      lifecycleStatus: "failed",
      ...(issueControl.activeWorkspaceOwnershipId !== undefined
        ? { activeWorkspaceOwnershipId: issueControl.activeWorkspaceOwnershipId }
        : {}),
      ...(issueControl.serviceOwnedCommentId ? { serviceOwnedCommentId: issueControl.serviceOwnedCommentId } : {}),
      ...(issueControl.activeAgentSessionId ? { activeAgentSessionId: issueControl.activeAgentSessionId } : {}),
    });
  }
}
