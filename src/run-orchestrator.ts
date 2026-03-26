import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import { ACTIVE_RUN_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import { buildHookEnv, runProjectHook } from "./hook-runner.ts";
import {
  buildAgentSessionPlanForIssue,
} from "./agent-session-plan.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import {
  buildStageReport,
  countEventMethods,
  extractTurnId,
  resolveRunCompletionStatus,
  summarizeCurrentThread,
} from "./run-reporting.ts";
import {
  buildRunCompletedActivity,
  buildRunFailureActivity,
  buildRunStartedActivity,
} from "./linear-session-reporting.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClientProvider,
  LinearAgentActivityContent,
} from "./types.ts";
import { resolveAuthoritativeLinearStopState } from "./linear-workflow.ts";
import { execCommand } from "./utils.ts";

const DEFAULT_CI_REPAIR_BUDGET = 3;
const DEFAULT_QUEUE_REPAIR_BUDGET = 3;
const DEFAULT_REVIEW_FIX_BUDGET = 3;

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function lowerCaseFirst(value: string): string {
  return value ? `${value.slice(0, 1).toLowerCase()}${value.slice(1)}` : value;
}

const WORKFLOW_FILES: Record<RunType, string> = {
  implementation: "IMPLEMENTATION_WORKFLOW.md",
  review_fix: "REVIEW_WORKFLOW.md",
  ci_repair: "IMPLEMENTATION_WORKFLOW.md",
  queue_repair: "IMPLEMENTATION_WORKFLOW.md",
};

function readWorkflowFile(repoPath: string, runType: RunType): string | undefined {
  const filename = WORKFLOW_FILES[runType];
  const filePath = path.join(repoPath, filename);
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath, "utf8").trim();
}

function buildRunPrompt(issue: IssueRecord, runType: RunType, repoPath: string, context?: Record<string, unknown>): string {
  const lines: string[] = [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.branchName ? `Branch: ${issue.branchName}` : undefined,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
    "",
  ].filter(Boolean) as string[];

  const promptContext = typeof context?.promptContext === "string" ? context.promptContext.trim() : "";
  const latestPrompt = typeof context?.promptBody === "string" ? context.promptBody.trim() : "";
  if (promptContext) {
    lines.push("## Linear Session Context", "", promptContext, "");
  }
  if (latestPrompt) {
    lines.push("## Latest Human Instruction", "", latestPrompt, "");
  }

  // Add run-type-specific context for reactive runs
  switch (runType) {
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
        "",
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
        "Read the review feedback and PR comments (`gh pr view --comments`), address each point, run verification, commit and push.",
        "",
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
        "",
      );
      break;
  }

  // Append the repo's workflow file
  const workflowBody = readWorkflowFile(repoPath, runType);
  if (workflowBody) {
    lines.push(workflowBody);
  } else if (runType === "implementation") {
    // Fallback if no workflow file exists
    lines.push(
      "Implement the Linear issue. Read the issue via MCP for details.",
      "Run verification before finishing. Commit, push, and open a PR.",
    );
  }

  return lines.join("\n");
}

const PROGRESS_THROTTLE_MS = 10_000;

export class RunOrchestrator {
  private readonly worktreeManager: WorktreeManager;
  private readonly progressThrottle = new Map<number, number>();
  private activeThreadId: string | undefined;
  botIdentity?: GitHubAppBotIdentity;

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
    if (runType === "review_fix" && issue.reviewFixAttempts >= DEFAULT_REVIEW_FIX_BUDGET) {
      this.escalate(issue, runType, `Review fix budget exhausted (${DEFAULT_REVIEW_FIX_BUDGET} attempts)`);
      return;
    }

    // Increment repair counters
    if (runType === "ci_repair") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, ciRepairAttempts: issue.ciRepairAttempts + 1 });
    }
    if (runType === "queue_repair") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueRepairAttempts: issue.queueRepairAttempts + 1 });
    }
    if (runType === "review_fix") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, reviewFixAttempts: issue.reviewFixAttempts + 1 });
    }

    // Build prompt
    const prompt = buildRunPrompt(issue, runType, project.repoPath, context);

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
          : runType === "review_fix" ? "changes_requested"
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

      // Set bot git identity when GitHub App is configured
      if (this.botIdentity) {
        const gitBin = this.config.runner.gitBin;
        await execCommand(gitBin, ["-C", worktreePath, "config", "user.name", this.botIdentity.name], { timeoutMs: 5_000 });
        await execCommand(gitBin, ["-C", worktreePath, "config", "user.email", this.botIdentity.email], { timeoutMs: 5_000 });
      }

      // Run prepare-worktree hook
      const hookEnv = buildHookEnv(issue.issueKey ?? issue.linearIssueId, branchName, runType, worktreePath);
      const prepareResult = await runProjectHook(project.repoPath, "prepare-worktree", { cwd: worktreePath, env: hookEnv });
      if (prepareResult.ran && prepareResult.exitCode !== 0) {
        throw new Error(`prepare-worktree hook failed (exit ${prepareResult.exitCode}): ${prepareResult.stderr?.slice(0, 500) ?? ""}`);
      }

      // Reuse the existing thread only for review_fix (reviewer context matters).
      // Implementation, ci_repair, and queue_repair get fresh threads.
      if (issue.threadId && runType === "review_fix") {
        threadId = issue.threadId;
      } else {
        const thread = await this.codex.startThread({ cwd: worktreePath });
        threadId = thread.id;
        this.db.upsertIssue({ projectId: item.projectId, linearIssueId: item.issueId, threadId });
      }

      try {
        const turn = await this.codex.startTurn({ threadId, cwd: worktreePath, input: prompt });
        turnId = turn.turnId;
      } catch (turnError) {
        // If the thread is stale (e.g. after app-server restart), start fresh and retry once.
        const msg = turnError instanceof Error ? turnError.message : String(turnError);
        if (msg.includes("thread not found") || msg.includes("not materialized")) {
          this.logger.info({ issueKey: issue.issueKey, staleThreadId: threadId }, "Thread is stale, retrying with fresh thread");
          const thread = await this.codex.startThread({ cwd: worktreePath });
          threadId = thread.id;
          this.db.upsertIssue({ projectId: item.projectId, linearIssueId: item.issueId, threadId });
          const turn = await this.codex.startTurn({ threadId, cwd: worktreePath, input: prompt });
          turnId = turn.turnId;
        } else {
          throw turnError;
        }
      }
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
      const failedIssue = this.db.getIssue(item.projectId, item.issueId) ?? issue;
      void this.emitLinearActivity(failedIssue, buildRunFailureActivity(runType, `Failed to start ${lowerCaseFirst(message)}`));
      void this.syncLinearSession(failedIssue, { activeRunType: runType });
      throw error;
    }

    this.db.updateRunThread(run.id, { threadId, turnId });

    this.logger.info(
      { issueKey: issue.issueKey, runType, threadId, turnId },
      `Started ${runType} run`,
    );

    // Emit Linear activity + plan
    const freshIssue = this.db.getIssue(item.projectId, item.issueId) ?? issue;
    void this.emitLinearActivity(freshIssue, buildRunStartedActivity(runType));
    void this.syncLinearSession(freshIssue, { activeRunType: runType });
  }

  // ─── Notification handler ─────────────────────────────────────────

  async handleCodexNotification(notification: CodexNotification): Promise<void> {
    // threadId is present on turn-level notifications but NOT on item-level ones.
    // Fall back to the tracked active thread for item/delta notifications.
    let threadId = typeof notification.params.threadId === "string" ? notification.params.threadId : undefined;
    if (!threadId) {
      threadId = this.activeThreadId;
    }
    if (!threadId) return;

    // Track the active thread from turn/started so item notifications can find it
    if (notification.method === "turn/started" && threadId) {
      this.activeThreadId = threadId;
    }

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

    // Emit ephemeral progress activity to Linear for notable in-flight events
    this.maybeEmitProgressActivity(notification, run);

    // Sync codex plan to Linear session when it updates
    if (notification.method === "turn/plan/updated") {
      const issue = this.db.getIssue(run.projectId, run.linearIssueId);
      if (issue) {
        void this.syncLinearSessionWithCodexPlan(issue, notification.params, run.runType);
      }
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
      const failedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.emitLinearActivity(failedIssue, buildRunFailureActivity(run.runType));
      void this.syncLinearSession(failedIssue, { activeRunType: run.runType });
      this.progressThrottle.delete(run.id);
      this.activeThreadId = undefined;
      return;
    }

    // Complete the run
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const report = buildStageReport(run, trackedIssue, thread, countEventMethods(this.db.listThreadEvents(run.id)));

    // Determine post-run state based on current PR metadata.
    const freshIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
    const postRunState = resolvePostRunState(freshIssue);

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
        ...(postRunState ? { factoryState: postRunState } : {}),
        ...(postRunState === "awaiting_queue" ? { pendingMergePrep: true } : {}),
      });
    });

    // If we advanced to awaiting_queue, enqueue for merge prep
    if (postRunState === "awaiting_queue") {
      this.enqueueIssue(run.projectId, run.linearIssueId);
    }

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

    // Emit Linear completion activity + plan
    const updatedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
    const completionSummary = report.assistantMessages.at(-1)?.slice(0, 300) ?? `${run.runType} completed.`;
    void this.emitLinearActivity(updatedIssue, buildRunCompletedActivity({
      runType: run.runType,
      completionSummary,
      postRunState: updatedIssue.factoryState,
      ...(updatedIssue.prNumber !== undefined ? { prNumber: updatedIssue.prNumber } : {}),
    }));
    void this.syncLinearSession(updatedIssue);
    this.progressThrottle.delete(run.id);
    this.activeThreadId = undefined;
  }

  // ─── In-flight progress ──────────────────────────────────────────

  private maybeEmitProgressActivity(notification: CodexNotification, run: RunRecord): void {
    const activity = this.resolveProgressActivity(notification);
    if (!activity) return;

    const now = Date.now();
    const lastEmit = this.progressThrottle.get(run.id) ?? 0;
    if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
    this.progressThrottle.set(run.id, now);

    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      void this.emitLinearActivity(issue, activity, { ephemeral: true });
    }
  }

  private resolveProgressActivity(notification: CodexNotification): LinearAgentActivityContent | undefined {
    if (notification.method === "item/started") {
      const item = notification.params.item as Record<string, unknown> | undefined;
      if (!item) return undefined;
      const type = typeof item.type === "string" ? item.type : undefined;

      if (type === "commandExecution") {
        const cmd = item.command;
        const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : undefined;
        return { type: "action", action: "Running", parameter: cmdStr?.slice(0, 120) ?? "command" };
      }
      if (type === "mcpToolCall") {
        const server = typeof item.server === "string" ? item.server : "";
        const tool = typeof item.tool === "string" ? item.tool : "";
        return { type: "action", action: "Using", parameter: `${server}/${tool}` };
      }
      if (type === "dynamicToolCall") {
        const tool = typeof item.tool === "string" ? item.tool : "tool";
        return { type: "action", action: "Using", parameter: tool };
      }
    }
    return undefined;
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

  async reconcileActiveRuns(): Promise<void> {
    for (const run of this.db.listRunningRuns()) {
      await this.reconcileRun(run);
    }
    // Advance issues stuck in pr_open whose stored PR metadata already
    // shows they should transition (e.g. approved PR, missed webhook).
    await this.reconcileIdleIssues();
  }

  private async reconcileIdleIssues(): Promise<void> {
    for (const issue of this.db.listIdleNonTerminalIssues()) {
      // PR already merged — advance to done regardless of current state
      if (issue.prState === "merged") {
        this.advanceIdleIssue(issue, "done");
        continue;
      }

      // Review approved + checks not failed — advance to awaiting_queue
      if (issue.prReviewState === "approved" && issue.prCheckStatus !== "failed") {
        this.advanceIdleIssue(issue, "awaiting_queue");
        continue;
      }

      // Checks failed + idle (not already in a repair state) — enqueue ci_repair
      if (issue.prCheckStatus === "failed" && issue.factoryState !== "repairing_ci") {
        this.advanceIdleIssue(issue, "repairing_ci", "ci_repair");
        continue;
      }

      // Awaiting queue with stale pending merge prep — re-enqueue
      if (issue.factoryState === "awaiting_queue" && issue.pendingMergePrep) {
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
        continue;
      }

      // For pr_open issues with no review decision, check GitHub for stale metadata
      if (issue.factoryState === "pr_open" && !issue.prReviewState) {
        await this.reconcileFromGitHub(issue);
      }
    }
  }

  private async reconcileFromGitHub(issue: IssueRecord): Promise<void> {
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project?.github?.repoFullName || !issue.prNumber) return;
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "state,reviewDecision",
      ], { timeoutMs: 10_000 });
      const pr = JSON.parse(stdout) as { state?: string; reviewDecision?: string };
      if (pr.state === "MERGED") {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
        this.advanceIdleIssue(issue, "done");
      } else if (pr.reviewDecision === "APPROVED") {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prReviewState: "approved" });
        this.advanceIdleIssue(issue, "awaiting_queue");
      }
    } catch (error) {
      this.logger.debug(
        { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
        "Failed to query GitHub PR state during reconciliation",
      );
    }
  }

  private advanceIdleIssue(issue: IssueRecord, newState: FactoryState, pendingRunType?: string): void {
    this.logger.info(
      { issueKey: issue.issueKey, from: issue.factoryState, to: newState, pendingRunType },
      "Reconciliation: advancing idle issue",
    );
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: newState,
      ...(newState === "awaiting_queue" ? { pendingMergePrep: true } : {}),
      ...(pendingRunType ? { pendingRunType: pendingRunType as never } : {}),
    });
    if (newState === "awaiting_queue" || pendingRunType) {
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  private async reconcileRun(run: RunRecord): Promise<void> {
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    // Zombie run: claimed in DB but Codex never started (no thread).
    // This happens when the service crashes between claiming the run
    // and starting the Codex turn. Re-enqueue instead of failing.
    if (!run.threadId) {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType },
        "Zombie run detected (no thread) — clearing and re-enqueueing",
      );
      this.db.transaction(() => {
        this.db.finishRun(run.id, { status: "failed", failureReason: "Zombie: never started (no thread after restart)" });
        this.db.upsertIssue({
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          pendingRunType: run.runType,
          pendingRunContextJson: null,
        });
      });
      this.enqueueIssue(run.projectId, run.linearIssueId);
      return;
    }

    // Read Codex state — thread may not exist after app-server restart.
    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.readThreadWithRetry(run.threadId);
    } catch {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType, threadId: run.threadId },
        "Stale thread during reconciliation — clearing and re-enqueueing",
      );
      this.db.transaction(() => {
        this.db.finishRun(run.id, { status: "failed", failureReason: "Stale thread after restart" });
        this.db.upsertIssue({
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          pendingRunType: run.runType,
          pendingRunContextJson: null,
        });
      });
      this.enqueueIssue(run.projectId, run.linearIssueId);
      return;
    }

    // Check Linear state (non-fatal — token refresh may fail)
    const linear = await this.linearProvider.forProject(run.projectId).catch(() => undefined);
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

    // Handle interrupted turn — fail the run rather than retrying indefinitely.
    // The agent may have partially completed work (commits, PR) before interruption.
    // Reactive loops (CI repair, review fix) will handle follow-up if needed.
    if (latestTurn?.status === "interrupted") {
      this.logger.warn(
        { issueKey: issue.issueKey, runType: run.runType, threadId: run.threadId },
        "Run has interrupted turn — marking as failed",
      );
      // Interrupted runs are not real failures — undo the budget increment.
      if (run.runType === "ci_repair" && issue.ciRepairAttempts > 0) {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, ciRepairAttempts: issue.ciRepairAttempts - 1 });
      } else if (run.runType === "queue_repair" && issue.queueRepairAttempts > 0) {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueRepairAttempts: issue.queueRepairAttempts - 1 });
      } else if (run.runType === "review_fix" && issue.reviewFixAttempts > 0) {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, reviewFixAttempts: issue.reviewFixAttempts - 1 });
      }
      this.failRunAndClear(run, "Codex turn was interrupted");
      const failedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.emitLinearActivity(failedIssue, buildRunFailureActivity(run.runType, "The Codex turn was interrupted."));
      void this.syncLinearSession(failedIssue, { activeRunType: run.runType });
      return;
    }

    // Handle completed turn discovered during reconciliation
    if (latestTurn?.status === "completed") {
      const trackedIssue = this.db.issueToTrackedIssue(issue);
      const report = buildStageReport(run, trackedIssue, thread, countEventMethods(this.db.listThreadEvents(run.id)));
      const freshIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      const postRunState = resolvePostRunState(freshIssue);
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
          ...(postRunState ? { factoryState: postRunState } : {}),
          ...(postRunState === "awaiting_queue" ? { pendingMergePrep: true } : {}),
        });
      });
      if (postRunState === "awaiting_queue") {
        this.enqueueIssue(run.projectId, run.linearIssueId);
      }
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────

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
    const escalatedIssue = this.db.getIssue(issue.projectId, issue.linearIssueId) ?? issue;
    void this.emitLinearActivity(escalatedIssue, {
      type: "error",
      body: `PatchRelay needs human help to continue.\n\n${reason}`,
    });
    void this.syncLinearSession(escalatedIssue);
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

  private async emitLinearActivity(
    issue: IssueRecord,
    content: LinearAgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    if (!issue.agentSessionId) return;
    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear) return;
      const allowEphemeral = content.type === "thought" || content.type === "action";
      await linear.createAgentActivity({
        agentSessionId: issue.agentSessionId,
        content,
        ...(options?.ephemeral && allowEphemeral ? { ephemeral: true } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, type: content.type, error: msg }, "Failed to emit Linear activity");
      this.feed?.publish({
        level: "warn",
        kind: "linear",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        status: "linear_error",
        summary: `Linear activity failed: ${msg}`,
      });
    }
  }

  private async syncLinearSession(issue: IssueRecord, options?: { activeRunType?: RunType }): Promise<void> {
    if (!issue.agentSessionId) return;
    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear?.updateAgentSession) return;
      const externalUrls = buildAgentSessionExternalUrls(this.config, {
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
      });
      await linear.updateAgentSession({
        agentSessionId: issue.agentSessionId,
        plan: buildAgentSessionPlanForIssue(issue, options),
        ...(externalUrls ? { externalUrls } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to update Linear plan");
    }
  }

  private async syncLinearSessionWithCodexPlan(
    issue: IssueRecord,
    params: Record<string, unknown>,
    runType: string,
  ): Promise<void> {
    if (!issue.agentSessionId) return;
    const plan = params.plan;
    if (!Array.isArray(plan)) return;

    const STATUS_MAP: Record<string, "pending" | "inProgress" | "completed"> = {
      pending: "pending",
      inProgress: "inProgress",
      completed: "completed",
    };

    const steps = plan.map((entry) => {
      const e = entry as Record<string, unknown>;
      const step = typeof e.step === "string" ? e.step : String(e.step ?? "");
      const status = typeof e.status === "string" ? (STATUS_MAP[e.status] ?? "pending") : "pending";
      return { content: step, status };
    });

    // Prepend a "Prepare workspace" completed step and append a "Merge" pending step
    // to frame the codex plan within the PatchRelay lifecycle
    const fullPlan = [
      { content: "Prepare workspace", status: "completed" as const },
      ...steps,
      { content: "Merge", status: "pending" as const },
    ];

    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear?.updateAgentSession) return;
      await linear.updateAgentSession({
        agentSessionId: issue.agentSessionId,
        plan: fullPlan,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync codex plan to Linear");
    }
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

/**
 * Determine post-run factory state from current PR metadata.
 * Used by both the normal completion path and reconciliation.
 */
function resolvePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (ACTIVE_RUN_STATES.has(issue.factoryState) && issue.prNumber) {
    if (issue.prReviewState === "approved") return "awaiting_queue";
    if (issue.prState === "merged") return "done";
    return "pr_open";
  }
  return undefined;
}
