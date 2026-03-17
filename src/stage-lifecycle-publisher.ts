import type { Logger } from "pino";
import {
  buildAwaitingHandoffSessionPlan,
  buildCompletedSessionPlan,
  buildRunningSessionPlan,
} from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import type { IssueControlStoreProvider } from "./ledger-ports.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { IssueWorkflowCoordinatorProvider, IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import {
  buildAwaitingHandoffComment,
  buildRunningStatusComment,
  resolveActiveLinearState,
  resolveWorkflowLabelCleanup,
  resolveWorkflowLabelNames,
} from "./linear-workflow.ts";
import type { AppConfig, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

export class StageLifecyclePublisher {
  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowCoordinatorProvider & IssueWorkflowQueryStoreProvider & IssueControlStoreProvider,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async markStageActive(
    project: AppConfig["projects"][number],
    issue: TrackedIssueRecord,
    stageRun: StageRunRecord,
  ): Promise<void> {
    const activeState = resolveActiveLinearState(project, stageRun.stage);
    const linear = await this.linearProvider.forProject(stageRun.projectId);
    if (!activeState || !linear) {
      return;
    }

    await linear.setIssueState(stageRun.linearIssueId, activeState);
    const labels = resolveWorkflowLabelNames(project, "working");
    if (labels.add.length > 0 || labels.remove.length > 0) {
      await linear.updateIssueLabels({
        issueId: stageRun.linearIssueId,
        ...(labels.add.length > 0 ? { addNames: labels.add } : {}),
        ...(labels.remove.length > 0 ? { removeNames: labels.remove } : {}),
      });
    }
    this.stores.workflowCoordinator.upsertTrackedIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      currentLinearState: activeState,
      statusCommentId: issue.statusCommentId ?? null,
      activeAgentSessionId: issue.activeAgentSessionId ?? null,
      lifecycleStatus: "running",
    });
  }

  async refreshRunningStatusComment(projectId: string, issueId: string, stageRunId: number, issueKey?: string): Promise<void> {
    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) {
      return;
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(projectId, issueId);
    const stageRun = this.stores.issueWorkflows.getStageRun(stageRunId);
    const workspace = stageRun ? this.stores.issueWorkflows.getWorkspace(stageRun.workspaceId) : undefined;
    if (!issue || !stageRun || !workspace) {
      return;
    }
    if (issue.activeAgentSessionId) {
      return;
    }

    try {
      const result = await linear.upsertIssueComment({
        issueId,
        ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
        body: buildRunningStatusComment({
          issue,
          stageRun,
          branchName: workspace.branchName,
        }),
      });
      this.stores.workflowCoordinator.setIssueStatusComment(projectId, issueId, result.id);
    } catch (error) {
      this.logger.warn(
        {
          issueKey,
          stageRunId,
          issueId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to refresh running status comment after stage startup",
      );
    }
  }

  async publishStageStarted(issue: TrackedIssueRecord, stage: StageRunRecord["stage"]): Promise<void> {
    if (!issue.activeAgentSessionId) {
      return;
    }

    const linear = await this.linearProvider.forProject(issue.projectId);
    if (!linear) {
      return;
    }

    try {
      const externalUrls = buildAgentSessionExternalUrls(this.config, issue.issueKey);
      await linear.updateAgentSession?.({
        agentSessionId: issue.activeAgentSessionId,
        ...(externalUrls ? { externalUrls } : {}),
        plan: buildRunningSessionPlan(stage),
      });
      await linear.createAgentActivity({
        agentSessionId: issue.activeAgentSessionId,
        content: {
          type: "action",
          action: "running_workflow",
          parameter: stage,
          result: `PatchRelay started the ${stage} workflow.`,
        },
        ephemeral: true,
      });
    } catch (error) {
      this.logger.warn(
        {
          issueKey: issue.issueKey,
          stage,
          agentSessionId: issue.activeAgentSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to publish Linear agent activity after stage startup",
      );
    }
  }

  async publishStageCompletion(
    stageRun: StageRunRecord,
    enqueueIssue: (projectId: string, issueId: string) => void,
  ): Promise<void> {
    const refreshedIssue = this.stores.issueWorkflows.getTrackedIssue(stageRun.projectId, stageRun.linearIssueId);
    if (refreshedIssue?.desiredStage) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: refreshedIssue.issueKey,
        projectId: refreshedIssue.projectId,
        stage: stageRun.stage,
        status: "queued",
        summary: `Completed ${stageRun.stage} workflow and queued ${refreshedIssue.desiredStage}`,
      });
      await this.publishAgentCompletion(refreshedIssue, {
        type: "thought",
        body: `The ${stageRun.stage} workflow finished. PatchRelay is preparing the next requested workflow.`,
      });
      enqueueIssue(stageRun.projectId, stageRun.linearIssueId);
      return;
    }

    const project = this.config.projects.find((candidate) => candidate.id === stageRun.projectId);
    const activeState = project ? resolveActiveLinearState(project, stageRun.stage) : undefined;
    const linear = project ? await this.linearProvider.forProject(stageRun.projectId) : undefined;
    if (refreshedIssue && linear && project && activeState) {
      try {
        const linearIssue = await linear.getIssue(stageRun.linearIssueId);
        if (linearIssue.stateName?.trim().toLowerCase() === activeState.trim().toLowerCase()) {
          const labels = resolveWorkflowLabelNames(project, "awaitingHandoff");
          if (labels.add.length > 0 || labels.remove.length > 0) {
            await linear.updateIssueLabels({
              issueId: stageRun.linearIssueId,
              ...(labels.add.length > 0 ? { addNames: labels.add } : {}),
              ...(labels.remove.length > 0 ? { removeNames: labels.remove } : {}),
            });
          }
          this.stores.workflowCoordinator.setIssueLifecycleStatus(stageRun.projectId, stageRun.linearIssueId, "paused");

          const finalStageRun = this.stores.issueWorkflows.getStageRun(stageRun.id) ?? stageRun;
          if (refreshedIssue.activeAgentSessionId) {
            const externalUrls = buildAgentSessionExternalUrls(this.config, refreshedIssue.issueKey);
            await linear.updateAgentSession?.({
              agentSessionId: refreshedIssue.activeAgentSessionId,
              ...(externalUrls ? { externalUrls } : {}),
              plan: buildAwaitingHandoffSessionPlan(stageRun.stage),
            });
          } else {
            const result = await linear.upsertIssueComment({
              issueId: stageRun.linearIssueId,
              ...(refreshedIssue.statusCommentId ? { commentId: refreshedIssue.statusCommentId } : {}),
              body: buildAwaitingHandoffComment({
                issue: refreshedIssue,
                stageRun: finalStageRun,
                activeState,
              }),
            });
            this.stores.workflowCoordinator.setIssueStatusComment(stageRun.projectId, stageRun.linearIssueId, result.id);
          }
          this.feed?.publish({
            level: "info",
            kind: "stage",
            issueKey: refreshedIssue.issueKey,
            projectId: refreshedIssue.projectId,
            stage: stageRun.stage,
            status: "handoff",
            summary: `Completed ${stageRun.stage} workflow`,
            detail: `Waiting for a Linear state change or follow-up input while the issue remains in ${activeState}.`,
          });
          await this.publishAgentCompletion(refreshedIssue, {
            type: "elicitation",
            body: `PatchRelay finished the ${stageRun.stage} workflow. Move the issue to its next workflow state or leave a follow-up prompt to continue.`,
          });
          return;
        }

        const cleanup = resolveWorkflowLabelCleanup(project);
        if (cleanup.remove.length > 0) {
          await linear.updateIssueLabels({
            issueId: stageRun.linearIssueId,
            removeNames: cleanup.remove,
          });
        }
      } catch (error) {
        this.logger.warn(
          {
            issueKey: refreshedIssue.issueKey,
            issueId: stageRun.linearIssueId,
            stageRunId: stageRun.id,
            stage: stageRun.stage,
            error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
          },
          "Stage completed locally but PatchRelay could not finish the final Linear sync",
        );
      }
    }

    if (refreshedIssue) {
      if (refreshedIssue.activeAgentSessionId) {
        const externalUrls = buildAgentSessionExternalUrls(this.config, refreshedIssue.issueKey);
        await linear?.updateAgentSession?.({
          agentSessionId: refreshedIssue.activeAgentSessionId,
          ...(externalUrls ? { externalUrls } : {}),
          plan: buildCompletedSessionPlan(stageRun.stage),
        });
      }
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: refreshedIssue.issueKey,
        projectId: refreshedIssue.projectId,
        stage: stageRun.stage,
        status: "completed",
        summary: `Completed ${stageRun.stage} workflow`,
      });
      await this.publishAgentCompletion(refreshedIssue, {
        type: "response",
        body: `PatchRelay finished the ${stageRun.stage} workflow.`,
      });
    }
  }

  private async publishAgentCompletion(
    issue: TrackedIssueRecord,
    content:
      | { type: "thought" | "elicitation" | "response" | "error"; body: string }
      | { type: "action"; action: string; parameter: string; result?: string },
  ): Promise<void> {
    if (!issue.activeAgentSessionId) {
      return;
    }

    const linear = await this.linearProvider.forProject(issue.projectId);
    if (!linear) {
      return;
    }

    await linear
      .createAgentActivity({
        agentSessionId: issue.activeAgentSessionId,
        content,
      })
      .catch((error) => {
        this.logger.warn(
          {
            issueKey: issue.issueKey,
            issueId: issue.linearIssueId,
            agentSessionId: issue.activeAgentSessionId,
            activityType: content.type,
            error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
          },
          "Failed to publish Linear agent activity",
        );
      });
  }
}
