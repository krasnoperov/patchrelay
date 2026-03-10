import { existsSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.js";
import type { PatchRelayDatabase } from "./db.js";
import {
  buildRunningStatusComment,
  resolveActiveLinearState,
  resolveWorkflowLabelNames,
} from "./linear-workflow.js";
import { buildStageLaunchPlan, isCodexThreadId } from "./stage-launch.js";
import { syncFailedStageToLinear } from "./stage-failure.js";
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

    let threadLaunch;
    let turn;
    try {
      await ensureDir(project.worktreeRoot);
      await this.ensureWorktree(project.repoPath, project.worktreeRoot, plan.worktreePath, plan.branchName);
      await this.markStageActive(project, claim.issue, claim.stageRun);

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

    this.db.updateStageRunThread({
      stageRunId: claim.stageRun.id,
      threadId: threadLaunch.threadId,
      ...(threadLaunch.parentThreadId ? { parentThreadId: threadLaunch.parentThreadId } : {}),
      turnId: turn.turnId,
    });

    for (const input of this.db.listPendingTurnInputs(claim.stageRun.id)) {
      this.db.setPendingTurnInputRouting(input.id, threadLaunch.threadId, turn.turnId);
    }
    await this.deliverPendingTurnInputs(claim.issue, claim.stageRun.id, threadLaunch.threadId, turn.turnId);
    await this.refreshStatusComment(item.projectId, item.issueId, claim.stageRun.id, issue.issueKey);

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
    threadId?: string,
  ): Promise<void> {
    const failureThreadId = threadId ?? `launch-failed-${stageRun.id}`;
    this.db.finishStageRun({
      stageRunId: stageRun.id,
      status: "failed",
      threadId: failureThreadId,
      summaryJson: JSON.stringify({ message }),
      reportJson: JSON.stringify(buildFailedStageReport(stageRun, "failed", { threadId: failureThreadId })),
    });

    await syncFailedStageToLinear({
      db: this.db,
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

  private async ensureWorktree(repoPath: string, worktreeRoot: string, worktreePath: string, branchName: string): Promise<void> {
    if (existsSync(worktreePath)) {
      await this.assertTrustedExistingWorktree(repoPath, worktreeRoot, worktreePath);
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

  private async assertTrustedExistingWorktree(repoPath: string, worktreeRoot: string, worktreePath: string): Promise<void> {
    const worktreeStats = lstatSync(worktreePath);
    if (worktreeStats.isSymbolicLink()) {
      throw new Error(`Refusing to reuse symlinked worktree path: ${worktreePath}`);
    }
    if (!worktreeStats.isDirectory()) {
      throw new Error(`Refusing to reuse non-directory worktree path: ${worktreePath}`);
    }

    const resolvedRoot = realpathSync(worktreeRoot);
    const resolvedWorktree = realpathSync(worktreePath);
    if (!isPathWithinRoot(resolvedRoot, resolvedWorktree)) {
      throw new Error(`Refusing to reuse worktree outside configured root: ${worktreePath}`);
    }

    const listedWorktrees = await this.listRegisteredWorktrees(repoPath);
    if (!listedWorktrees.has(resolvedWorktree)) {
      throw new Error(`Refusing to reuse unregistered worktree path: ${worktreePath}`);
    }
  }

  private async listRegisteredWorktrees(repoPath: string): Promise<Set<string>> {
    const result = await execCommand(this.config.runner.gitBin, ["-C", repoPath, "worktree", "list", "--porcelain"], {
      timeoutMs: 120_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Unable to verify registered worktrees for ${repoPath}`);
    }

    const worktrees = new Set<string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.startsWith("worktree ")) {
        continue;
      }

      const listedPath = line.slice("worktree ".length).trim();
      if (!listedPath) {
        continue;
      }

      try {
        worktrees.add(realpathSync(listedPath));
      } catch {
        worktrees.add(path.resolve(listedPath));
      }
    }

    return worktrees;
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

  private async deliverPendingTurnInputs(
    issue: TrackedIssueRecord,
    stageRunId: number,
    threadId: string,
    turnId: string,
  ): Promise<void> {
    for (const input of this.db.listPendingTurnInputs(stageRunId)) {
      try {
        await this.codex.steerTurn({
          threadId,
          turnId,
          input: input.body,
        });
        this.db.markTurnInputDelivered(input.id);
      } catch (steerError) {
        this.logger.warn(
          {
            issueKey: issue.issueKey,
            threadId,
            turnId,
            queuedInputId: input.id,
            error: steerError instanceof Error ? steerError.message : String(steerError),
          },
          "Failed to deliver queued Linear comment during stage startup",
        );
        break;
      }
    }
  }

  private async refreshStatusComment(
    projectId: string,
    issueId: string,
    stageRunId: number,
    issueKey?: string,
  ): Promise<void> {
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
      this.db.setIssueStatusComment(projectId, issueId, result.id);
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
}

function isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
