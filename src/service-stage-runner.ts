import { existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.js";
import type { PatchRelayDatabase } from "./db.js";
import {
  buildLaunchFailedComment,
  buildRunningStatusComment,
  resolveActiveLinearState,
  resolveWorkflowLabelCleanup,
  resolveWorkflowLabelNames,
} from "./linear-workflow.js";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.js";
import { buildFailedStageReport } from "./stage-reporting.js";
import type { AppConfig, LinearClientProvider, StageRunRecord, TrackedIssueRecord } from "./types.js";
import { ensureDir, execCommand } from "./utils.js";

export interface IssueQueueItem {
  projectId: string;
  issueId: string;
}

export class ServiceStageRunner {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {}

  async run(item: IssueQueueItem): Promise<void> {
    const project = this.config.projects.find((candidate) => candidate.id === item.projectId);
    if (!project) {
      return;
    }

    const issue = this.db.getTrackedIssue(item.projectId, item.issueId);
    if (!issue || !issue.desiredStage || !issue.desiredWebhookId || issue.activeStageRunId) {
      return;
    }

    const plan = buildStageLaunchPlan(project, issue, issue.desiredStage);
    const claim = this.db.claimStageRun({
      projectId: item.projectId,
      linearIssueId: item.issueId,
      stage: issue.desiredStage,
      triggerWebhookId: issue.desiredWebhookId,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      workflowFile: plan.workflowFile,
      promptText: plan.prompt,
    });
    if (!claim) {
      return;
    }

    try {
      await ensureDir(project.worktreeRoot);
      await this.ensureWorktree(project.repoPath, plan.worktreePath, plan.branchName);
      await this.markStageActive(project, claim.issue, claim.stageRun);

      const threadLaunch = await this.launchStageThread(item.projectId, item.issueId, claim.stageRun.id, plan.worktreePath, issue.issueKey);
      const turn = await this.codex.startTurn({
        threadId: threadLaunch.threadId,
        cwd: plan.worktreePath,
        input: plan.prompt,
      });

      this.db.updateStageRunThread({
        stageRunId: claim.stageRun.id,
        threadId: threadLaunch.threadId,
        ...(threadLaunch.parentThreadId ? { parentThreadId: threadLaunch.parentThreadId } : {}),
        turnId: turn.turnId,
      });

      for (const input of this.db.listPendingTurnInputs(claim.stageRun.id)) {
        this.db.setPendingTurnInputRouting(input.id, threadLaunch.threadId, turn.turnId);
      }
      for (const input of this.db.listPendingTurnInputs(claim.stageRun.id)) {
        try {
          await this.codex.steerTurn({
            threadId: threadLaunch.threadId,
            turnId: turn.turnId,
            input: input.body,
          });
          this.db.markTurnInputDelivered(input.id);
        } catch (steerError) {
          this.logger.warn(
            {
              issueKey: issue.issueKey,
              threadId: threadLaunch.threadId,
              turnId: turn.turnId,
              queuedInputId: input.id,
              error: steerError instanceof Error ? steerError.message : String(steerError),
            },
            "Failed to deliver queued Linear comment during stage startup",
          );
          break;
        }
      }
      await this.refreshStatusComment(item.projectId, item.issueId, claim.stageRun.id);

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
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await this.markLaunchFailed(project, claim.issue, claim.stageRun, err.message);
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
  }

  private async launchStageThread(
    projectId: string,
    issueId: string,
    stageRunId: number,
    worktreePath: string,
    issueKey?: string,
  ): Promise<{ threadId: string; parentThreadId?: string }> {
    const previousStageRun = this.db
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
  ): Promise<void> {
    const failureThreadId = `launch-failed-${stageRun.id}`;
    this.db.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId: failureThreadId,
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId: failureThreadId })),
    });

    const linear = await this.linearProvider.forProject(stageRun.projectId);
    if (!linear) {
      return;
    }

    const fallbackState = project.workflowStatuses.humanNeeded;
    if (fallbackState) {
      await linear.setIssueState(stageRun.linearIssueId, fallbackState).catch(() => undefined);
      this.db.setIssueLifecycleStatus(stageRun.projectId, stageRun.linearIssueId, "failed");
      this.db.upsertTrackedIssue({
        projectId: stageRun.projectId,
        linearIssueId: stageRun.linearIssueId,
        currentLinearState: fallbackState,
        statusCommentId: issue.statusCommentId ?? null,
        lifecycleStatus: "failed",
      });
    }

    const cleanup = resolveWorkflowLabelCleanup(project);
    if (cleanup.remove.length > 0) {
      await linear
        .updateIssueLabels({
          issueId: stageRun.linearIssueId,
          removeNames: cleanup.remove,
        })
        .catch(() => undefined);
    }

    const result = await linear
      .upsertIssueComment({
        issueId: stageRun.linearIssueId,
        ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
        body: buildLaunchFailedComment({
          issue,
          stageRun,
          message,
          ...(fallbackState ? { fallbackState } : {}),
        }),
      })
      .catch(() => undefined);
    if (result) {
      this.db.setIssueStatusComment(stageRun.projectId, stageRun.linearIssueId, result.id);
    }
  }

  private async ensureWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
    if (existsSync(worktreePath)) {
      return;
    }

    await ensureDir(path.dirname(worktreePath));
    await execCommand(
      this.config.runner.gitBin,
      ["-C", repoPath, "worktree", "add", "--force", "-B", branchName, worktreePath, "HEAD"],
      {
        timeoutMs: 120_000,
      },
    );
  }

  private async markStageActive(
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
    this.db.upsertTrackedIssue({
      projectId: stageRun.projectId,
      linearIssueId: stageRun.linearIssueId,
      currentLinearState: activeState,
      statusCommentId: issue?.statusCommentId ?? null,
      lifecycleStatus: "running",
    });
  }

  private async refreshStatusComment(projectId: string, issueId: string, stageRunId: number): Promise<void> {
    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) {
      return;
    }

    const issue = this.db.getTrackedIssue(projectId, issueId);
    const stageRun = this.db.getStageRun(stageRunId);
    const workspace = stageRun ? this.db.getWorkspace(stageRun.workspaceId) : undefined;
    if (!issue || !stageRun || !workspace) {
      return;
    }

    const result = await linear.upsertIssueComment({
      issueId,
      ...(issue.statusCommentId ? { commentId: issue.statusCommentId } : {}),
      body: buildRunningStatusComment({
        issue,
        stageRun,
        branchName: workspace.branchName,
        worktreePath: workspace.worktreePath,
      }),
    });
    this.db.setIssueStatusComment(projectId, issueId, result.id);
  }
}
