import type { Logger } from "pino";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunType } from "./db-types.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { buildHookEnv, runProjectHook } from "./hook-runner.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import {
  buildCiRepairPrompt,
  buildQueueRepairPrompt,
  buildReviewFixPrompt,
  type CiRepairContext,
  type QueueRepairContext,
  type ReviewFixContext,
} from "./reactive-prompts.ts";
import type { AppConfig } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

const DEFAULT_CI_REPAIR_BUDGET = 2;
const DEFAULT_QUEUE_REPAIR_BUDGET = 2;

export class ReactiveExecutor {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    const issue = this.db.getIssue(item.projectId, item.issueId);
    if (!issue?.pendingRunType || issue.activeRunId !== undefined) return;

    const runType = issue.pendingRunType;
    const contextJson = issue.pendingRunContextJson;
    const context = contextJson ? safeJsonParse(contextJson) : undefined;

    // Clear the pending run before starting
    this.db.upsertIssue({
      projectId: item.projectId,
      linearIssueId: item.issueId,
      pendingRunType: null,
      pendingRunContextJson: null,
    });

    switch (runType) {
      case "ci_repair":
        await this.handleCiRepair(issue, (context ?? {}) as CiRepairContext);
        break;
      case "review_fix":
        await this.handleReviewFix(issue, (context ?? {}) as ReviewFixContext);
        break;
      case "queue_repair":
        await this.handleQueueRepair(issue, (context ?? {}) as QueueRepairContext);
        break;
      default:
        this.logger.warn({ runType, issueKey: issue.issueKey }, "Unknown reactive run type");
    }
  }

  private async handleCiRepair(issue: IssueRecord, context: CiRepairContext): Promise<void> {
    const budget = DEFAULT_CI_REPAIR_BUDGET;
    if (issue.ciRepairAttempts >= budget) {
      this.escalate(issue, "ci_repair", `CI repair budget exhausted (${budget} attempts)`);
      return;
    }

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      ciRepairAttempts: issue.ciRepairAttempts + 1,
    });

    const prompt = buildCiRepairPrompt(issue, context);
    await this.startReactiveRun(issue, "ci_repair", prompt);
  }

  private async handleReviewFix(issue: IssueRecord, context: ReviewFixContext): Promise<void> {
    const prompt = buildReviewFixPrompt(issue, context);
    await this.startReactiveRun(issue, "review_fix", prompt);
  }

  private async handleQueueRepair(issue: IssueRecord, context: QueueRepairContext): Promise<void> {
    const budget = DEFAULT_QUEUE_REPAIR_BUDGET;
    if (issue.queueRepairAttempts >= budget) {
      this.escalate(issue, "queue_repair", `Merge queue repair budget exhausted (${budget} attempts)`);
      return;
    }

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      queueRepairAttempts: issue.queueRepairAttempts + 1,
    });

    const prompt = buildQueueRepairPrompt(issue, context);
    await this.startReactiveRun(issue, "queue_repair", prompt);
  }

  private async startReactiveRun(issue: IssueRecord, runType: RunType, prompt: string): Promise<void> {
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project) return;

    if (!issue.worktreePath) {
      this.logger.warn({ issueKey: issue.issueKey, runType }, "No worktree for reactive run");
      return;
    }

    // Create the run record
    const run = this.db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      stage: runType,
      promptText: prompt,
    });

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
      lifecycleStatus: "running",
    });

    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: runType,
      status: "starting",
      summary: `Starting ${runType} run`,
    });

    try {
      // Run prepare-worktree hook
      const hookEnv = buildHookEnv(
        issue.issueKey ?? issue.linearIssueId,
        issue.branchName ?? "",
        runType,
        issue.worktreePath,
      );
      const prepareResult = await runProjectHook(project.repoPath, "prepare-worktree", {
        cwd: issue.worktreePath,
        env: hookEnv,
      });
      if (prepareResult.ran && prepareResult.exitCode !== 0) {
        throw new Error(`prepare-worktree hook failed (exit ${prepareResult.exitCode})`);
      }

      // Reuse existing thread or create new one
      let threadId: string;
      if (issue.threadId) {
        threadId = issue.threadId;
      } else {
        const thread = await this.codex.startThread({ cwd: issue.worktreePath });
        threadId = thread.id;
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          threadId,
        });
      }

      const turn = await this.codex.startTurn({
        threadId,
        cwd: issue.worktreePath,
        input: prompt,
      });

      this.db.updateRunThread(run.id, { threadId, turnId: turn.turnId });

      this.logger.info(
        { issueKey: issue.issueKey, runType, threadId, turnId: turn.turnId },
        `Started reactive ${runType} run`,
      );

      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: runType,
        status: "running",
        summary: `${runType} agent is working`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.finishRun(run.id, { status: "failed", failureReason: message });
      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        activeRunId: null,
        lifecycleStatus: "failed",
      });

      this.logger.error({ issueKey: issue.issueKey, runType, error: message }, `Failed to start ${runType} run`);
      this.feed?.publish({
        level: "error",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: runType,
        status: "failed",
        summary: `${runType} run failed to start`,
        detail: message,
      });
    }
  }

  private escalate(issue: IssueRecord, runType: string, reason: string): void {
    this.logger.warn({ issueKey: issue.issueKey, runType, reason }, "Escalating to human");

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      lifecycleStatus: "failed",
    });

    this.feed?.publish({
      level: "error",
      kind: "workflow",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: runType,
      status: "escalated",
      summary: `Escalated: ${reason}`,
    });
  }
}
