import type { Logger } from "pino";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord, TrackedIssueRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import { buildHookEnv, runProjectHook } from "./hook-runner.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import {
  buildStageReport,
  buildFailedStageReport,
  countEventMethods,
  extractTurnId,
  resolveRunCompletionStatus,
  summarizeCurrentThread,
} from "./run-reporting.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClientProvider,
  StageReport,
} from "./types.ts";
import { resolveAuthoritativeLinearStopState } from "./linear-workflow.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

const DEFAULT_CI_REPAIR_BUDGET = 2;
const DEFAULT_QUEUE_REPAIR_BUDGET = 2;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildRunPrompt(issue: IssueRecord, runType: RunType, context?: Record<string, unknown>): string {
  const lines: string[] = [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    `Branch: ${issue.branchName}`,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
    "",
  ].filter(Boolean) as string[];

  switch (runType) {
    case "implementation":
      lines.push(
        "## Implementation",
        "",
        "Implement the Linear issue. Read the issue via MCP for details.",
        "Run verification before finishing. Commit your changes.",
      );
      break;
    case "ci_repair":
      lines.push(
        "## CI Repair",
        "",
        "A CI check has failed on your PR. Fix the failure and push.",
        context?.checkName ? `Failed check: ${String(context.checkName)}` : "",
        context?.checkUrl ? `Check URL: ${String(context.checkUrl)}` : "",
        "",
        "Read the CI failure logs, fix the code issue, run verification, commit and push.",
        "Do not change test expectations unless the test is genuinely wrong.",
      );
      break;
    case "review_fix":
      lines.push(
        "## Review Changes Requested",
        "",
        "A reviewer has requested changes on your PR. Address the feedback and push.",
        context?.reviewerName ? `Reviewer: ${String(context.reviewerName)}` : "",
        context?.reviewBody ? `\n## Review comment\n\n${String(context.reviewBody)}` : "",
        "",
        "Read the review feedback, address each point, run verification, commit and push.",
      );
      break;
    case "queue_repair":
      lines.push(
        "## Merge Queue Failure",
        "",
        "The merge queue rejected this PR. Rebase onto latest main and fix conflicts.",
        context?.failureReason ? `Failure reason: ${String(context.failureReason)}` : "",
        "",
        "Fetch and rebase onto latest main, resolve conflicts, run verification, push.",
        "If the conflict is a semantic contradiction, explain and stop.",
      );
      break;
  }

  return lines.join("\n");
}

export class RunOrchestrator {
  private readonly worktreeManager: WorktreeManager;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly linearProvider: LinearClientProvider,
    private readonly enqueueIssue: (projectId: string, issueId: string) => void,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {
    this.worktreeManager = new WorktreeManager(config);
  }

  // ─── Run ────────────────────────────────────────────────────────

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    const project = this.config.projects.find((p) => p.id === item.projectId);
    if (!project) return;

    const issue = this.db.getIssue(item.projectId, item.issueId);
    if (!issue?.pendingRunType || issue.activeRunId !== undefined) return;

    const runType = issue.pendingRunType;
    const contextJson = issue.pendingRunContextJson;
    const context = contextJson ? JSON.parse(contextJson) as Record<string, unknown> : undefined;

    // Check repair budgets
    if (runType === "ci_repair" && issue.ciRepairAttempts >= DEFAULT_CI_REPAIR_BUDGET) {
      this.escalate(issue, runType, `CI repair budget exhausted (${DEFAULT_CI_REPAIR_BUDGET} attempts)`);
      return;
    }
    if (runType === "queue_repair" && issue.queueRepairAttempts >= DEFAULT_QUEUE_REPAIR_BUDGET) {
      this.escalate(issue, runType, `Queue repair budget exhausted (${DEFAULT_QUEUE_REPAIR_BUDGET} attempts)`);
      return;
    }

    // Increment repair counters
    if (runType === "ci_repair") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, ciRepairAttempts: issue.ciRepairAttempts + 1 });
    }
    if (runType === "queue_repair") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueRepairAttempts: issue.queueRepairAttempts + 1 });
    }

    // Build prompt
    const prompt = buildRunPrompt(issue, runType, context);

    // Resolve workspace
    const issueRef = sanitizePathSegment(issue.issueKey ?? issue.linearIssueId);
    const slug = issue.title ? slugify(issue.title) : "";
    const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;
    const branchName = issue.branchName ?? `${project.branchPrefix}/${branchSuffix}`;
    const worktreePath = issue.worktreePath ?? `${project.worktreeRoot}/${issueRef}`;

    // Claim the run atomically
    const run = this.db.transaction(() => {
      const fresh = this.db.getIssue(item.projectId, item.issueId);
      if (!fresh?.pendingRunType || fresh.activeRunId !== undefined) return undefined;

      const created = this.db.createRun({
        issueId: fresh.id,
        projectId: item.projectId,
        linearIssueId: item.issueId,
        runType,
        promptText: prompt,
      });
      this.db.upsertIssue({
        projectId: item.projectId,
        linearIssueId: item.issueId,
        pendingRunType: null,
        pendingRunContextJson: null,
        activeRunId: created.id,
        branchName,
        worktreePath,
        factoryState: runType === "implementation" ? "implementing"
          : runType === "ci_repair" ? "repairing_ci"
          : runType === "queue_repair" ? "repairing_queue"
          : "implementing",
      });
      return created;
    });
    if (!run) return;

    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: item.projectId,
      stage: runType,
      status: "starting",
      summary: `Starting ${runType} run`,
    });

    let threadId: string;
    let turnId: string;
    try {
      // Ensure worktree
      await this.worktreeManager.ensureIssueWorktree(
        project.repoPath,
        project.worktreeRoot,
        worktreePath,
        branchName,
        { allowExistingOutsideRoot: issue.branchName !== undefined },
      );

      // Run prepare-worktree hook
      const hookEnv = buildHookEnv(issue.issueKey ?? issue.linearIssueId, branchName, runType, worktreePath);
      const prepareResult = await runProjectHook(project.repoPath, "prepare-worktree", { cwd: worktreePath, env: hookEnv });
      if (prepareResult.ran && prepareResult.exitCode !== 0) {
        throw new Error(`prepare-worktree hook failed (exit ${prepareResult.exitCode}): ${prepareResult.stderr?.slice(0, 500) ?? ""}`);
      }

      // Start or reuse Codex thread
      if (issue.threadId && runType !== "implementation") {
        threadId = issue.threadId;
      } else {
        const thread = await this.codex.startThread({ cwd: worktreePath });
        threadId = thread.id;
        this.db.upsertIssue({ projectId: item.projectId, linearIssueId: item.issueId, threadId });
      }

      const turn = await this.codex.startTurn({ threadId, cwd: worktreePath, input: prompt });
      turnId = turn.turnId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.finishRun(run.id, { status: "failed", failureReason: message });
      this.db.upsertIssue({
        projectId: item.projectId,
        linearIssueId: item.issueId,
        activeRunId: null,
        factoryState: "failed",
      });
      this.logger.error({ issueKey: issue.issueKey, runType, error: message }, `Failed to launch ${runType} run`);
      throw error;
    }

    this.db.updateRunThread(run.id, { threadId, turnId });

    this.logger.info(
      { issueKey: issue.issueKey, runType, threadId, turnId },
      `Started ${runType} run`,
    );
  }

  // ─── Notification handler ─────────────────────────────────────────

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    const threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) return;

    const run = this.db.getRunByThreadId(threadId);
    if (!run) return;

    const turnId = typeof notification.params.turnId === "string" ? notification.params.turnId : undefined;
    if (this.config.runner.codex.persistExtendedHistory) {
      this.db.saveThreadEvent({
        runId: run.id,
        threadId,
        ...(turnId ? { turnId } : {}),
        method: notification.method,
        eventJson: JSON.stringify(notification.params),
      });
    }

    if (notification.method !== "turn/completed") return;

    const thread = await this.readThreadWithRetry(threadId);
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveRunCompletionStatus(notification.params);

    if (status === "failed") {
      this.db.finishRun(run.id, {
        status: "failed",
        threadId,
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
        failureReason: "Codex reported the turn completed in a failed state",
      });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        factoryState: "failed",
      });
      this.feed?.publish({
        level: "error",
        kind: "turn",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "failed",
        summary: `Turn failed for ${run.runType}`,
      });
      return;
    }

    // Complete the run
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const report = buildStageReport(run, trackedIssue, thread, countEventMethods(this.db.listThreadEvents(run.id)));

    this.db.transaction(() => {
      this.db.finishRun(run.id, {
        status: "completed",
        threadId,
        ...(completedTurnId ? { turnId: completedTurnId } : {}),
        summaryJson: JSON.stringify({ latestAssistantMessage: report.assistantMessages.at(-1) ?? null }),
        reportJson: JSON.stringify(report),
      });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
      });
    });

    this.feed?.publish({
      level: "info",
      kind: "turn",
      issueKey: issue.issueKey,
      projectId: run.projectId,
      stage: run.runType,
      status: "completed",
      summary: `Turn completed for ${run.runType}`,
      detail: summarizeCurrentThread(thread).latestAgentMessage,
    });

    // Run after-{runType} hook
    await this.runAfterHook(run, issue);
  }

  // ─── Active status for query ──────────────────────────────────────

  async getActiveRunStatus(issueKey: string) {
    const issue = this.db.getIssueByKey(issueKey);
    if (!issue?.activeRunId) return undefined;

    const run = this.db.getRun(issue.activeRunId);
    if (!run?.threadId) return undefined;

    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const thread = await this.codex.readThread(run.threadId, true).catch(() => undefined);

    return {
      issue: trackedIssue,
      run,
      ...(thread ? { liveThread: summarizeCurrentThread(thread) } : {}),
    };
  }

  // ─── Reconciliation ───────────────────────────────────────────────

  async reconcileActiveStageRuns(): Promise<void> {
    return this.reconcileActiveRuns();
  }

  async reconcileActiveRuns(): Promise<void> {
    for (const run of this.db.listRunningRuns()) {
      await this.reconcileRun(run);
    }
  }

  private async reconcileRun(run: RunRecord): Promise<void> {
    if (!run.threadId) {
      this.failRunAndClear(run, "Run has no thread ID during reconciliation");
      return;
    }

    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    // Read Codex state
    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.readThreadWithRetry(run.threadId);
    } catch {
      this.failRunAndClear(run, "Codex thread not found during reconciliation");
      return;
    }

    // Check Linear state
    const linear = await this.linearProvider.forProject(run.projectId);
    if (linear) {
      const linearIssue = await linear.getIssue(run.linearIssueId).catch(() => undefined);
      if (linearIssue) {
        const stopState = resolveAuthoritativeLinearStopState(linearIssue);
        if (stopState?.isFinal) {
          this.db.transaction(() => {
            this.db.finishRun(run.id, { status: "released" });
            this.db.upsertIssue({
              projectId: run.projectId,
              linearIssueId: run.linearIssueId,
              activeRunId: null,
              currentLinearState: stopState.stateName,
              factoryState: "done",
            });
          });
          return;
        }
      }
    }

    const latestTurn = thread.turns.at(-1);

    // Handle interrupted turn - restart
    if (latestTurn?.status === "interrupted") {
      if (!issue.worktreePath) return;
      try {
        const turn = await this.codex.startTurn({
          threadId: run.threadId,
          cwd: issue.worktreePath,
          input: `Your previous turn was interrupted. Continue the ${run.runType} work from where you left off.`,
        });
        this.db.updateRunTurnId(run.id, turn.turnId);
        this.logger.info(
          { issueKey: issue.issueKey, runType: run.runType, threadId: run.threadId, turnId: turn.turnId },
          "Restarted interrupted run during reconciliation",
        );
      } catch (error) {
        this.failRunAndClear(run, `Failed to restart interrupted turn: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    // Handle completed turn discovered during reconciliation
    if (latestTurn?.status === "completed") {
      const trackedIssue = this.db.issueToTrackedIssue(issue);
      const report = buildStageReport(run, trackedIssue, thread, countEventMethods(this.db.listThreadEvents(run.id)));
      this.db.transaction(() => {
        this.db.finishRun(run.id, {
          status: "completed",
          ...(run.threadId ? { threadId: run.threadId } : {}),
          ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
          summaryJson: JSON.stringify({ latestAssistantMessage: report.assistantMessages.at(-1) ?? null }),
          reportJson: JSON.stringify(report),
        });
        this.db.upsertIssue({
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
        });
      });
      await this.runAfterHook(run, issue);
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private async runAfterHook(run: RunRecord, issue: IssueRecord): Promise<void> {
    const project = this.config.projects.find((p) => p.id === run.projectId);
    if (!project || !issue.worktreePath) return;

    const hookName = `after-${run.runType}`;
    const hookEnv = buildHookEnv(
      issue.issueKey ?? issue.linearIssueId,
      issue.branchName ?? "",
      run.runType,
      issue.worktreePath,
    );

    try {
      const result = await runProjectHook(project.repoPath, hookName, { cwd: issue.worktreePath, env: hookEnv });
      if (!result.ran) return;

      this.logger.info(
        { issueKey: issue.issueKey, runType: run.runType, hookExitCode: result.exitCode },
        `${hookName} hook completed`,
      );
      this.feed?.publish({
        level: result.exitCode === 0 ? "info" : "warn",
        kind: "hook",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: result.exitCode === 0 ? "completed" : "failed",
        summary: `${hookName} hook ${result.exitCode === 0 ? "succeeded" : "failed"}`,
        detail: result.exitCode !== 0 ? result.stderr?.slice(0, 500) : undefined,
      });
    } catch (error) {
      this.logger.warn(
        { issueKey: issue.issueKey, runType: run.runType, error: error instanceof Error ? error.message : String(error) },
        `${hookName} hook threw an error (non-blocking)`,
      );
    }
  }

  private escalate(issue: IssueRecord, runType: string, reason: string): void {
    this.logger.warn({ issueKey: issue.issueKey, runType, reason }, "Escalating to human");
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: null,
      pendingRunContextJson: null,
      factoryState: "escalated",
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

  private failRunAndClear(run: RunRecord, message: string): void {
    this.db.transaction(() => {
      this.db.finishRun(run.id, { status: "failed", failureReason: message });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        factoryState: "failed",
      });
    });
  }

  private async readThreadWithRetry(threadId: string, maxRetries = 3): Promise<CodexThreadSummary> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await this.codex.readThread(threadId, true);
      } catch {
        if (attempt === maxRetries - 1) throw new Error(`Failed to read thread ${threadId} after ${maxRetries} attempts`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw new Error(`Failed to read thread ${threadId}`);
  }
}
