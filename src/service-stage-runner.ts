import path from "node:path";
import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.js";
import type { PatchRelayDatabase } from "./db.js";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.js";
import { buildFailedStageReport } from "./stage-reporting.js";
import type { AppConfig, StageRunRecord } from "./types.js";
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

    await ensureDir(project.worktreeRoot);
    await this.ensureWorktree(project.repoPath, plan.worktreePath, plan.branchName);

    try {
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
      this.markLaunchFailed(claim.stageRun, err.message);
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

  private markLaunchFailed(stageRun: StageRunRecord, message: string): void {
    const failureThreadId = `launch-failed-${stageRun.id}`;
    this.db.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId: failureThreadId,
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId: failureThreadId })),
    });
  }

  private async ensureWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
    await ensureDir(path.dirname(worktreePath));
    await execCommand(
      this.config.runner.gitBin,
      ["-C", repoPath, "worktree", "add", "--force", "-B", branchName, worktreePath, "HEAD"],
      {
        timeoutMs: 120_000,
      },
    );
  }
}
