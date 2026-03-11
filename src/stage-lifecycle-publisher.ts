import type { Logger } from "pino";
import type { IssueWorkflowLifecycleStoreProvider } from "./workflow-ports.ts";
import {
  buildAwaitingHandoffComment,
  buildRunningStatusComment,
  resolveActiveLinearState,
  resolveWorkflowLabelCleanup,
  resolveWorkflowLabelNames,
} from "./linear-workflow.ts";
import type { AppConfig, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.ts";

export class StageLifecyclePublisher {
  constructor(
    private readonly config: AppConfig,
    private readonly stores: IssueWorkflowLifecycleStoreProvider,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
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
    this.stores.issueWorkflows.upsertTrackedIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      currentLinearState: activeState,
      statusCommentId: issue.statusCommentId ?? null,
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
      this.stores.issueWorkflows.setIssueStatusComment(projectId, issueId, result.id);
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
    const pipeline = this.stores.issueWorkflows.getPipelineRun(stageRun.pipelineRunId);
    if (refreshedIssue?.desiredStage) {
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
    if (refreshedIssue && pipeline && linear && project && activeState) {
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
          this.stores.issueWorkflows.setIssueLifecycleStatus(stageRun.projectId, stageRun.linearIssueId, "paused");
          this.stores.issueWorkflows.setPipelineStatus(pipeline.id, "paused");

          const finalStageRun = this.stores.issueWorkflows.getStageRun(stageRun.id) ?? stageRun;
          const result = await linear.upsertIssueComment({
            issueId: stageRun.linearIssueId,
            ...(refreshedIssue.statusCommentId ? { commentId: refreshedIssue.statusCommentId } : {}),
            body: buildAwaitingHandoffComment({
              issue: refreshedIssue,
              stageRun: finalStageRun,
              activeState,
            }),
          });
          this.stores.issueWorkflows.setIssueStatusComment(stageRun.projectId, stageRun.linearIssueId, result.id);
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
      } catch {
        // Preserve the completed stage locally even if Linear read-back failed.
      }
    }

    if (pipeline) {
      this.stores.issueWorkflows.markPipelineCompleted(pipeline.id);
    }
    if (refreshedIssue) {
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
      .catch(() => undefined);
  }
}
