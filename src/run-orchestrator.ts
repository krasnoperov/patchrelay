import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { BranchOwner, IssueRecord, RunRecord } from "./db-types.ts";
import { ACTIVE_RUN_STATES, TERMINAL_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import { parseGitHubFailureContext } from "./github-failure-context.ts";
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
import {
  requestMergeQueueAdmission,
  resolveMergeQueueProtocol,
} from "./merge-queue-protocol.ts";
import { parseStoredQueueRepairContext } from "./merge-queue-incident.ts";
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
const DEFAULT_ZOMBIE_RECOVERY_BUDGET = 5;
const ZOMBIE_RECOVERY_BASE_DELAY_MS = 15_000; // 15s, 30s, 60s, 120s, 240s
// Queue health monitor: wait before probing a freshly-queued PR.
// TODO: replace updatedAt with a true factory_state_changed_at timestamp —
// updatedAt can reset on unrelated row mutations (e.g. webhook metadata).
const QUEUE_HEALTH_GRACE_MS = 120_000;
// Suppress repeated probe-failure feed events — at most one per issue per window.
const QUEUE_HEALTH_PROBE_FAILURE_COOLDOWN_MS = 300_000; // 5 minutes

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
    case "ci_repair": {
      const snapshot = context?.ciSnapshot && typeof context.ciSnapshot === "object"
        ? context.ciSnapshot as {
            gateCheckName?: string;
            gateCheckStatus?: string;
            settledAt?: string;
            failedChecks?: Array<{ name?: string; summary?: string }>;
          }
        : undefined;
      lines.push(
        "## CI Repair",
        "",
        "A full CI iteration has settled failed on your PR. Start from the specific failing check/job/step below on the latest remote PR branch tip, fix that concrete failure first, then push to the same PR branch.",
        snapshot?.gateCheckName ? `Gate check: ${String(snapshot.gateCheckName)}` : "",
        snapshot?.gateCheckStatus ? `Gate status: ${String(snapshot.gateCheckStatus)}` : "",
        snapshot?.settledAt ? `Settled at: ${String(snapshot.settledAt)}` : "",
        context?.failureHeadSha ? `Failing head SHA: ${String(context.failureHeadSha)}` : "",
        context?.checkName ? `Failed check: ${String(context.checkName)}` : "",
        context?.jobName && context?.jobName !== context?.checkName ? `Failed job: ${String(context.jobName)}` : "",
        context?.stepName ? `Failed step: ${String(context.stepName)}` : "",
        context?.summary ? `Failure summary: ${String(context.summary)}` : "",
        Array.isArray(snapshot?.failedChecks) && snapshot.failedChecks.length > 0
          ? `Other failed checks in the settled snapshot (context only; ignore unless the logs show the same root cause):\n${snapshot.failedChecks.map((entry) => `- ${String(entry.name ?? "unknown")}${entry.summary ? `: ${String(entry.summary)}` : ""}`).join("\n")}`
          : "",
        context?.checkUrl ? `Check URL: ${String(context.checkUrl)}` : "",
        Array.isArray(context?.annotations) && context.annotations.length > 0
          ? `Annotations:\n${context.annotations.map((entry) => `- ${String(entry)}`).join("\n")}`
          : "",
        "",
        "Fetch the latest remote branch state first. If the branch moved since this failure, restart from the new tip instead of pushing older work.",
        "Read the latest logs for the named failing check, fix that root cause, and only broaden scope when the logs show direct fallout from the same issue.",
        "Do not change workflows, dependency installation, or unrelated tests unless the failing logs clearly point there.",
        "Run focused verification for the named failure, then commit and push.",
        "Do not open a new PR. Keep working on the existing branch until CI goes green or the situation is clearly stuck.",
        "Do not change test expectations unless the test is genuinely wrong.",
        "",
      );
      break;
    }
    case "review_fix":
      lines.push(
        "## Review Changes Requested",
        "",
        "A reviewer has requested changes on your PR. Address the feedback and push.",
        context?.reviewerName ? `Reviewer: ${String(context.reviewerName)}` : "",
        context?.reviewBody ? `\n## Review comment\n\n${String(context.reviewBody)}` : "",
        "",
        "Steps:",
        "1. Read the review feedback and PR comments (`gh pr view --comments`).",
        "2. Check the current diff (`git diff origin/main`) — a prior rebase may have already resolved some concerns (e.g., scope-bundling from stale commits).",
        "3. For each review point: if already resolved, note why. If not, fix it.",
        "4. Run verification, commit and push.",
        "5. If you believe all concerns are resolved, request a re-review: `gh pr edit <PR#> --add-reviewer <reviewer>`.",
        "   Do NOT just post a comment saying \"resolved\" — the reviewer must re-review to dismiss the CHANGES_REQUESTED state.",
        "",
      );
      break;
    case "queue_repair":
      appendQueueRepairContext(lines, context);
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
  /** Tracks last probe-failure feed event per issue to avoid spamming the operator feed. */
  private readonly probeFailureFeedTimes = new Map<string, number>();
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

    if (issue.prState === "merged") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingRunType: null, factoryState: "done" as never });
      return;
    }

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
      const failureHeadSha = typeof context?.failureHeadSha === "string"
        ? context.failureHeadSha
        : typeof context?.headSha === "string" ? context.headSha : undefined;
      const failureSignature = typeof context?.failureSignature === "string" ? context.failureSignature : undefined;
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
        ...((runType === "ci_repair" || runType === "queue_repair") && failureSignature
          ? {
              lastAttemptedFailureSignature: failureSignature,
              lastAttemptedFailureHeadSha: failureHeadSha ?? null,
            }
          : {}),
      });
      this.db.setBranchOwner(item.projectId, item.issueId, "patchrelay");
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

      // Freshen the worktree: fetch + rebase onto latest base branch.
      // This prevents branch contamination when local main has drifted
      // and avoids scope-bundling review rejections from stale commits.
      // Skip for queue_repair — its entire purpose is to resolve rebase conflicts.
      if (runType !== "queue_repair") {
        await this.freshenWorktree(worktreePath, project, issue);
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

    // Reset zombie recovery counter — this run started successfully
    if (issue.zombieRecoveryAttempts > 0) {
      this.db.upsertIssue({
        projectId: item.projectId,
        linearIssueId: item.issueId,
        zombieRecoveryAttempts: 0,
        lastZombieRecoveryAt: null,
      });
    }

    this.logger.info(
      { issueKey: issue.issueKey, runType, threadId, turnId },
      `Started ${runType} run`,
    );

    // Emit Linear activity + plan
    const freshIssue = this.db.getIssue(item.projectId, item.issueId) ?? issue;
    void this.emitLinearActivity(freshIssue, buildRunStartedActivity(runType));
    void this.syncLinearSession(freshIssue, { activeRunType: runType });
  }

  // ─── Pre-run branch freshening ────────────────────────────────────

  /**
   * Fetch origin and rebase the worktree onto the latest base branch.
   *
   * Risks mitigated:
   * - Dirty worktree from interrupted run → stash before, pop after
   * - Conflicts → abort rebase, throw so the run fails with a clear reason
   * - Already up-to-date → no-op
   * - Keep publishing explicit: the orchestrator updates the local worktree
   *   only; the agent/run owns any later branch push.
   */
  private async freshenWorktree(
    worktreePath: string,
    project: { github?: { baseBranch?: string }; repoPath: string },
    issue: IssueRecord,
  ): Promise<void> {
    const gitBin = this.config.runner.gitBin;
    const baseBranch = project.github?.baseBranch ?? "main";

    // Stash any uncommitted changes from a previous interrupted run
    const stashResult = await execCommand(gitBin, ["-C", worktreePath, "stash"], { timeoutMs: 30_000 });
    const didStash = stashResult.exitCode === 0 && !stashResult.stdout?.includes("No local changes");

    // Fetch latest base
    const fetchResult = await execCommand(gitBin, ["-C", worktreePath, "fetch", "origin", baseBranch], { timeoutMs: 60_000 });
    if (fetchResult.exitCode !== 0) {
      this.logger.warn({ issueKey: issue.issueKey, stderr: fetchResult.stderr?.slice(0, 300) }, "Pre-run fetch failed, proceeding with current base");
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      return;
    }

    // Check if rebase is needed: is HEAD already on top of origin/baseBranch?
    const mergeBaseResult = await execCommand(gitBin, ["-C", worktreePath, "merge-base", "--is-ancestor", `origin/${baseBranch}`, "HEAD"], { timeoutMs: 10_000 });
    if (mergeBaseResult.exitCode === 0) {
      // Already up-to-date — no rebase needed
      this.logger.debug({ issueKey: issue.issueKey }, "Pre-run freshen: branch already up to date");
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      return;
    }

    // Rebase onto latest base
    const rebaseResult = await execCommand(gitBin, ["-C", worktreePath, "rebase", `origin/${baseBranch}`], { timeoutMs: 120_000 });
    if (rebaseResult.exitCode !== 0) {
      // Abort the failed rebase and restore state — then let the agent run
      // proceed. The agent can resolve the conflict itself (the workflow
      // prompt tells it to rebase and handle conflicts).
      await execCommand(gitBin, ["-C", worktreePath, "rebase", "--abort"], { timeoutMs: 10_000 });
      if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
      this.logger.warn({ issueKey: issue.issueKey, baseBranch }, "Pre-run freshen: rebase conflict, agent will resolve");
      return;
    }

    this.logger.info({ issueKey: issue.issueKey, baseBranch }, "Pre-run freshen: rebased locally onto latest base");

    // Restore stashed changes
    if (didStash) await execCommand(gitBin, ["-C", worktreePath, "stash", "pop"], { timeoutMs: 10_000 });
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
        void this.syncLinearSessionWithCodexPlan(issue, notification.params);
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
    const verifiedRepairError = await this.verifyReactiveRunAdvancedBranch(run, freshIssue);
    if (verifiedRepairError) {
      const holdState = resolveRecoverablePostRunState(freshIssue) ?? "failed";
      this.failRunAndClear(run, verifiedRepairError, holdState);
      const heldIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
      this.feed?.publish({
        level: "warn",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "branch_not_advanced",
        summary: verifiedRepairError,
      });
      void this.emitLinearActivity(heldIssue, buildRunFailureActivity(run.runType, verifiedRepairError));
      void this.syncLinearSession(heldIssue, { activeRunType: run.runType });
      this.progressThrottle.delete(run.id);
      this.activeThreadId = undefined;
      return;
    }
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
        ...(postRunState === "awaiting_queue" || postRunState === "done"
          ? {
              lastGitHubFailureSource: null,
              lastGitHubFailureHeadSha: null,
              lastGitHubFailureSignature: null,
              lastGitHubFailureCheckName: null,
              lastGitHubFailureCheckUrl: null,
              lastGitHubFailureContextJson: null,
              lastGitHubFailureAt: null,
              lastQueueIncidentJson: null,
              lastAttemptedFailureHeadSha: null,
              lastAttemptedFailureSignature: null,
            }
          : {}),
      });
      if (postRunState === "awaiting_queue") {
        this.db.setBranchOwner(run.projectId, run.linearIssueId, "merge_steward");
      }
    });

    // If we advanced to awaiting_queue, enqueue for merge prep
    if (postRunState === "awaiting_queue") {
      this.requestMergeQueueAdmission(issue, run.projectId);
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
    // Preemptively detect stuck merge-queue PRs (conflicts visible on
    // GitHub) and dispatch queue_repair before the Steward evicts.
    await this.reconcileQueueHealth();
    // Advance issues stuck in pr_open whose stored PR metadata already
    // shows they should transition (e.g. approved PR, missed webhook).
    await this.reconcileIdleIssues();
  }

  // ─── Queue Health Monitor ──────────────────────────────────────────

  private async reconcileQueueHealth(): Promise<void> {
    for (const issue of this.db.listAwaitingQueueIssues()) {
      await this.probeQueuedIssue(issue);
    }
  }

  private async probeQueuedIssue(issue: IssueRecord): Promise<void> {
    if (!issue.prNumber) return;
    const project = this.config.projects.find((p) => p.id === issue.projectId);
    if (!project?.github?.repoFullName) return;

    // Grace period — don't probe PRs that just entered the queue.
    const age = Date.now() - Date.parse(issue.updatedAt);
    if (age < QUEUE_HEALTH_GRACE_MS) return;

    const protocol = resolveMergeQueueProtocol(project);

    let pr: {
      state?: string;
      mergeable?: string;
      mergeStateStatus?: string;
      headRefOid?: string;
      labels?: Array<{ name: string }>;
    };
    try {
      const { stdout } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "state,mergeable,mergeStateStatus,headRefOid,labels",
      ], { timeoutMs: 10_000 });
      pr = JSON.parse(stdout) as typeof pr;
    } catch (error) {
      this.logger.debug(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, error: error instanceof Error ? error.message : String(error) },
        "Queue health: failed to probe GitHub PR state",
      );
      // Throttle feed events — at most one per issue per cooldown window.
      const issueKey = `${issue.projectId}::${issue.linearIssueId}`;
      const lastFeedAt = this.probeFailureFeedTimes.get(issueKey) ?? 0;
      if (Date.now() - lastFeedAt >= QUEUE_HEALTH_PROBE_FAILURE_COOLDOWN_MS) {
        this.probeFailureFeedTimes.set(issueKey, Date.now());
        this.feed?.publish({
          level: "info",
          kind: "github",
          issueKey: issue.issueKey,
          projectId: issue.projectId,
          stage: "awaiting_queue",
          status: "queue_health_probe_failed",
          summary: `Queue health: failed to probe PR #${issue.prNumber}`,
        });
      }
      return;
    }

    // Successful probe — clear any probe-failure throttle for this issue.
    this.probeFailureFeedTimes.delete(`${issue.projectId}::${issue.linearIssueId}`);

    // Missed merge webhook — advance to done.
    if (pr.state === "MERGED") {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prState: "merged" });
      this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
      return;
    }

    // Non-open PRs (closed, draft) — don't enter repair logic.
    if (pr.state !== "OPEN") return;

    // Verify admission label is still present — if the Steward removed it
    // (eviction, dequeue) but PatchRelay missed the webhook, we should not
    // treat a DIRTY PR as a queue-health problem.
    const hasQueueLabel = pr.labels?.some((l) => l.name === protocol.admissionLabel) ?? false;
    if (!hasQueueLabel) return;

    // Detect queue issues: either GitHub reports DIRTY, or the steward
    // eviction check run failed (webhook may have been missed).
    const isDirty = pr.mergeStateStatus === "DIRTY" || pr.mergeable === "CONFLICTING";
    let hasEvictionCheckRun = false;
    if (!isDirty) {
      // Check for missed eviction webhook by looking for the steward's
      // check run on the PR head.
      try {
        const { stdout: checksOut } = await execCommand("gh", [
          "api", `repos/${project.github.repoFullName}/commits/${pr.headRefOid}/check-runs`,
          "--jq", `.check_runs[] | select(.name == "${protocol.evictionCheckName}" and .conclusion == "failure") | .name`,
        ], { timeoutMs: 10_000 });
        hasEvictionCheckRun = checksOut.trim().length > 0;
      } catch {
        // Best-effort check.
      }
    }

    if (isDirty || hasEvictionCheckRun) {
      const headRefOid = pr.headRefOid ?? "unknown";
      const reason = hasEvictionCheckRun ? "queue_eviction_missed" : "preemptive_conflict";
      const signature = `preemptive_queue_conflict:${headRefOid}`;
      const pendingRunContext: Record<string, unknown> = {
        source: "queue_health_monitor",
        failureReason: reason,
        failureHeadSha: headRefOid,
        failureSignature: signature,
      };

      if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
        return;
      }

      this.db.upsertIssue({
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        lastAttemptedFailureHeadSha: headRefOid,
        lastAttemptedFailureSignature: signature,
      });
      this.advanceIdleIssue(issue, "repairing_queue", {
        pendingRunType: "queue_repair",
        pendingRunContext,
      });
      this.logger.info(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, headRefOid, reason },
        "Queue health: queue issue detected, dispatching repair",
      );
      this.feed?.publish({
        level: "warn",
        kind: "github",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        stage: "repairing_queue",
        status: hasEvictionCheckRun ? "queue_health_eviction_detected" : "queue_health_conflict_detected",
        summary: hasEvictionCheckRun
          ? `Queue health: missed eviction detected on PR #${issue.prNumber}, dispatching repair`
          : `Queue health: merge conflict detected on PR #${issue.prNumber}, dispatching preemptive repair`,
      });
    }
  }

  private async reconcileIdleIssues(): Promise<void> {
    for (const issue of this.db.listIdleNonTerminalIssues()) {
      // PR already merged — advance to done regardless of current state
      if (issue.prState === "merged") {
        this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
        continue;
      }

      // Review approved + checks not failed — advance to awaiting_queue
      if (issue.prReviewState === "approved" && issue.prCheckStatus !== "failed") {
        if (issue.factoryState !== "awaiting_queue" || issue.branchOwner !== "merge_steward") {
          this.advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });
        } else if (!issue.queueLabelApplied) {
          // Retry failed label application
          await this.requestMergeQueueAdmission(issue, issue.projectId);
        }
        continue;
      }

      // Checks failed + idle — route based on durable GitHub failure provenance.
      if (issue.prCheckStatus === "failed") {
        if (issue.lastGitHubFailureSource === "queue_eviction") {
          const pendingRunContext = buildFailureContext(issue);
          if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
            this.advanceIdleIssue(issue, "repairing_queue");
          } else {
            this.advanceIdleIssue(issue, "repairing_queue", {
              pendingRunType: "queue_repair",
              ...(pendingRunContext ? { pendingRunContext } : {}),
            });
          }
          continue;
        }

        if (issue.lastGitHubFailureSource === "branch_ci") {
          const pendingRunContext = buildFailureContext(issue);
          if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
            this.advanceIdleIssue(issue, "repairing_ci");
          } else {
            this.advanceIdleIssue(issue, "repairing_ci", {
              pendingRunType: "ci_repair",
              ...(pendingRunContext ? { pendingRunContext } : {}),
            });
          }
          continue;
        }

        if (issue.factoryState === "awaiting_queue") {
          // Infer provenance: check if steward eviction check run exists on the PR
          const inferProject = this.config.projects.find((p) => p.id === issue.projectId);
          const inferProtocol = resolveMergeQueueProtocol(inferProject);
          let inferred: "queue_eviction" | "branch_ci" = "branch_ci";
          const probeSha = issue.lastGitHubFailureHeadSha ?? issue.lastGitHubCiSnapshotHeadSha;
          if (inferProject?.github?.repoFullName && issue.prNumber && probeSha) {
            try {
              const { stdout } = await execCommand("gh", [
                "api",
                `repos/${inferProject.github.repoFullName}/commits/${probeSha}/check-runs`,
                "--jq", `.check_runs[] | select(.name == "${inferProtocol.evictionCheckName}" and .conclusion == "failure") | .name`,
              ], { timeoutMs: 10_000 });
              if (stdout.trim().length > 0) inferred = "queue_eviction";
            } catch { /* best effort */ }
          }
          const inferRunType = inferred === "queue_eviction" ? "queue_repair" : "ci_repair";
          const inferState = inferred === "queue_eviction" ? "repairing_queue" : "repairing_ci";
          this.logger.info(
            { issueKey: issue.issueKey, prNumber: issue.prNumber, inferred },
            "Inferred failure provenance for awaiting_queue issue",
          );
          const pendingRunContext = buildFailureContext(issue);
          this.advanceIdleIssue(issue, inferState as never, {
            pendingRunType: inferRunType,
            ...(pendingRunContext ? { pendingRunContext } : {}),
          });
          continue;
        }

        const pendingRunContext = buildFailureContext(issue);
        if (isDuplicateRepairAttempt(issue, pendingRunContext)) {
          this.advanceIdleIssue(issue, "repairing_ci");
        } else {
          this.advanceIdleIssue(issue, "repairing_ci", {
            pendingRunType: "ci_repair",
            ...(pendingRunContext ? { pendingRunContext } : {}),
          });
        }
        continue;
      }

      // For pr_open issues with no review decision, check GitHub for stale metadata
      if (issue.factoryState === "pr_open" && !issue.prReviewState) {
        await this.reconcileFromGitHub(issue);
      }
    }

    // Unblock delegated issues whose blockers have been resolved.
    for (const issue of this.db.listBlockedDelegatedIssues()) {
      const unresolved = this.db.countUnresolvedBlockers(issue.projectId, issue.linearIssueId);
      if (unresolved === 0) {
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          pendingRunType: "implementation",
        });
        this.enqueueIssue(issue.projectId, issue.linearIssueId);
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
        this.advanceIdleIssue(issue, "done", { clearFailureProvenance: true });
      } else if (pr.reviewDecision === "APPROVED") {
        this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, prReviewState: "approved" });
        this.advanceIdleIssue(issue, "awaiting_queue", { clearFailureProvenance: true });
      }
    } catch (error) {
      this.logger.debug(
        { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
        "Failed to query GitHub PR state during reconciliation",
      );
    }
  }

  private advanceIdleIssue(
    issue: IssueRecord,
    newState: FactoryState,
    options?: {
      pendingRunType?: RunType;
      pendingRunContext?: Record<string, unknown>;
      clearFailureProvenance?: boolean;
    },
  ): void {
    if (issue.factoryState === newState && !options?.pendingRunType && !options?.clearFailureProvenance) {
      return;
    }
    this.logger.info(
      { issueKey: issue.issueKey, from: issue.factoryState, to: newState, pendingRunType: options?.pendingRunType },
      "Reconciliation: advancing idle issue",
    );
    // Reset queueLabelApplied when entering or leaving awaiting_queue so
    // the retry loop re-applies the label on each queue cycle.
    const resetQueueLabel = newState === "awaiting_queue" || issue.factoryState === "awaiting_queue";

    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      factoryState: newState,
      ...(options?.pendingRunType ? { pendingRunType: options.pendingRunType } : {}),
      ...(options?.pendingRunType
        ? {
            pendingRunContextJson: options.pendingRunContext ? JSON.stringify(options.pendingRunContext) : null,
          }
        : {}),
      ...(resetQueueLabel ? { queueLabelApplied: false } : {}),
      ...(options?.clearFailureProvenance
        ? {
            lastGitHubFailureSource: null,
            lastGitHubFailureHeadSha: null,
            lastGitHubFailureSignature: null,
            lastGitHubFailureCheckName: null,
            lastGitHubFailureCheckUrl: null,
            lastGitHubFailureContextJson: null,
            lastGitHubFailureAt: null,
            lastQueueIncidentJson: null,
            lastAttemptedFailureHeadSha: null,
            lastAttemptedFailureSignature: null,
          }
        : {}),
    });
    const branchOwner = this.resolveBranchOwnerForStateTransition(newState, options?.pendingRunType);
    if (branchOwner) {
      this.db.setBranchOwner(issue.projectId, issue.linearIssueId, branchOwner);
    }
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: issue.projectId,
      stage: newState,
      status: "reconciled",
      summary: `Reconciliation: ${issue.factoryState} \u2192 ${newState}`,
    });
    if (newState === "awaiting_queue" && issue.factoryState !== "awaiting_queue") {
      this.requestMergeQueueAdmission(issue, issue.projectId);
    }
    if (options?.pendingRunType) {
      this.enqueueIssue(issue.projectId, issue.linearIssueId);
    }
  }

  /**
   * After a zombie/stale run is cleared, decide whether to re-enqueue
   * or escalate. Checks: PR already merged → done; budget exhausted →
   * escalate; backoff delay not elapsed → skip.
   */
  private recoverOrEscalate(issue: IssueRecord, runType: RunType, reason: string): void {
    // Re-read issue after the run was cleared (activeRunId is now null)
    const fresh = this.db.getIssue(issue.projectId, issue.linearIssueId);
    if (!fresh) return;

    // If PR already merged, transition to done — no retry needed
    if (fresh.prState === "merged") {
      this.db.upsertIssue({
        projectId: fresh.projectId,
        linearIssueId: fresh.linearIssueId,
        factoryState: "done",
        zombieRecoveryAttempts: 0,
        lastZombieRecoveryAt: null,
      });
      this.logger.info({ issueKey: fresh.issueKey, reason }, "Recovery: PR already merged — transitioning to done");
      return;
    }

    // Budget check
    const attempts = fresh.zombieRecoveryAttempts + 1;
    if (attempts > DEFAULT_ZOMBIE_RECOVERY_BUDGET) {
      this.db.upsertIssue({
        projectId: fresh.projectId,
        linearIssueId: fresh.linearIssueId,
        factoryState: "escalated",
      });
      this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: budget exhausted — escalating");
      this.feed?.publish({
        level: "error",
        kind: "workflow",
        issueKey: fresh.issueKey,
        projectId: fresh.projectId,
        stage: "escalated",
        status: "budget_exhausted",
        summary: `${reason} recovery failed after ${DEFAULT_ZOMBIE_RECOVERY_BUDGET} attempts`,
      });
      return;
    }

    // Exponential backoff — skip if delay hasn't elapsed
    if (fresh.lastZombieRecoveryAt) {
      const elapsed = Date.now() - new Date(fresh.lastZombieRecoveryAt).getTime();
      const delay = ZOMBIE_RECOVERY_BASE_DELAY_MS * Math.pow(2, fresh.zombieRecoveryAttempts);
      if (elapsed < delay) {
        this.logger.debug({ issueKey: fresh.issueKey, attempts: fresh.zombieRecoveryAttempts, delay, elapsed }, "Recovery: backoff not elapsed, skipping");
        return;
      }
    }

    // Re-enqueue with backoff tracking
    this.db.upsertIssue({
      projectId: fresh.projectId,
      linearIssueId: fresh.linearIssueId,
      pendingRunType: runType,
      pendingRunContextJson: null,
      zombieRecoveryAttempts: attempts,
      lastZombieRecoveryAt: new Date().toISOString(),
    });
    this.enqueueIssue(fresh.projectId, fresh.linearIssueId);
    this.logger.info({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: re-enqueued with backoff");
  }

  private async reconcileRun(run: RunRecord): Promise<void> {
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    // If the issue reached a terminal state while this run was active
    // (e.g. pr_merged processed, DB manually edited), just release the run.
    if (TERMINAL_STATES.has(issue.factoryState)) {
      this.db.transaction(() => {
        this.db.finishRun(run.id, { status: "released", failureReason: "Issue reached terminal state during active run" });
        this.db.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.logger.info({ issueKey: issue.issueKey, runId: run.id, factoryState: issue.factoryState }, "Reconciliation: released run on terminal issue");
      return;
    }

    // Zombie run: claimed in DB but Codex never started (no thread).
    if (!run.threadId) {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType },
        "Zombie run detected (no thread)",
      );
      this.db.transaction(() => {
        this.db.finishRun(run.id, { status: "failed", failureReason: "Zombie: never started (no thread after restart)" });
        this.db.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(issue, run.runType, "zombie");
      return;
    }

    // Read Codex state — thread may not exist after app-server restart.
    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.readThreadWithRetry(run.threadId);
    } catch {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType, threadId: run.threadId },
        "Stale thread during reconciliation",
      );
      this.db.transaction(() => {
        this.db.finishRun(run.id, { status: "failed", failureReason: "Stale thread after restart" });
        this.db.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(issue, run.runType, "stale_thread");
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
          this.feed?.publish({
            level: "info",
            kind: "stage",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: "done",
            status: "reconciled",
            summary: `Linear state ${stopState.stateName} \u2192 done`,
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
      const recoveredState = resolveRecoverablePostRunState(this.db.getIssue(run.projectId, run.linearIssueId) ?? issue);
      this.failRunAndClear(run, "Codex turn was interrupted", recoveredState);
      const failedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      if (recoveredState) {
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: recoveredState,
          status: "reconciled",
          summary: `Interrupted ${run.runType} recovered \u2192 ${recoveredState}`,
        });
      } else {
        void this.emitLinearActivity(failedIssue, buildRunFailureActivity(run.runType, "The Codex turn was interrupted."));
      }
      void this.syncLinearSession(failedIssue, { activeRunType: run.runType });
      return;
    }

    // Handle completed turn discovered during reconciliation
    if (latestTurn?.status === "completed") {
      const trackedIssue = this.db.issueToTrackedIssue(issue);
      const report = buildStageReport(run, trackedIssue, thread, countEventMethods(this.db.listThreadEvents(run.id)));
      const freshIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      const verifiedRepairError = await this.verifyReactiveRunAdvancedBranch(run, freshIssue);
      if (verifiedRepairError) {
        const holdState = resolveRecoverablePostRunState(freshIssue) ?? "failed";
        this.failRunAndClear(run, verifiedRepairError, holdState);
        this.feed?.publish({
          level: "warn",
          kind: "turn",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "branch_not_advanced",
          summary: verifiedRepairError,
        });
        return;
      }
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
          ...(postRunState === "awaiting_queue" || postRunState === "done"
            ? {
                lastGitHubFailureSource: null,
                lastGitHubFailureHeadSha: null,
                lastGitHubFailureSignature: null,
                lastGitHubFailureCheckName: null,
                lastGitHubFailureCheckUrl: null,
                lastGitHubFailureContextJson: null,
                lastGitHubFailureAt: null,
                lastQueueIncidentJson: null,
                lastAttemptedFailureHeadSha: null,
                lastAttemptedFailureSignature: null,
              }
            : {}),
          });
        if (postRunState === "awaiting_queue") {
          this.db.setBranchOwner(run.projectId, run.linearIssueId, "merge_steward");
        }
      });
      if (postRunState) {
        this.feed?.publish({
          level: "info",
          kind: "turn",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "completed",
          summary: `Reconciliation: ${run.runType} completed \u2192 ${postRunState}`,
        });
      }
      if (postRunState === "awaiting_queue") {
        this.requestMergeQueueAdmission(issue, run.projectId);
      }
    }
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private escalate(issue: IssueRecord, runType: string, reason: string): void {
    this.logger.warn({ issueKey: issue.issueKey, runType, reason }, "Escalating to human");
    if (issue.activeRunId) {
      this.db.finishRun(issue.activeRunId, { status: "released" });
    }
    this.db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      pendingRunType: null,
      pendingRunContextJson: null,
      activeRunId: null,
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

  /** Add the merge queue admission label for external-queue projects (best-effort). */
  private async requestMergeQueueAdmission(issue: IssueRecord, projectId: string): Promise<void> {
    const project = this.config.projects.find((p) => p.id === projectId);
    const protocol = resolveMergeQueueProtocol(project);
    const applied = await requestMergeQueueAdmission({
      issue,
      protocol,
      logger: this.logger,
      feed: this.feed,
    });
    if (applied) {
      this.db.upsertIssue({ projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueLabelApplied: true });
    }
  }

  private failRunAndClear(run: RunRecord, message: string, nextState: FactoryState = "failed"): void {
    this.db.transaction(() => {
      this.db.finishRun(run.id, { status: "failed", failureReason: message });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        factoryState: nextState,
      });
      const branchOwner = this.resolveBranchOwnerForStateTransition(nextState);
      if (branchOwner) {
        this.db.setBranchOwner(run.projectId, run.linearIssueId, branchOwner);
      }
    });
  }

  private resolveBranchOwnerForStateTransition(newState: FactoryState, pendingRunType?: RunType): BranchOwner | undefined {
    if (pendingRunType) return "patchrelay";
    if (newState === "awaiting_queue") return "merge_steward";
    if (newState === "repairing_ci" || newState === "repairing_queue") return "patchrelay";
    return undefined;
  }

  private async verifyReactiveRunAdvancedBranch(run: RunRecord, issue: IssueRecord): Promise<string | undefined> {
    if (run.runType !== "ci_repair" && run.runType !== "queue_repair") {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open" || !issue.lastGitHubFailureHeadSha) {
      return undefined;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    if (!project?.github?.repoFullName) {
      return undefined;
    }
    try {
      const { stdout, exitCode } = await execCommand("gh", [
        "pr", "view", String(issue.prNumber),
        "--repo", project.github.repoFullName,
        "--json", "headRefOid,state",
      ], { timeoutMs: 10_000 });
      if (exitCode !== 0) return undefined;
      const pr = JSON.parse(stdout) as { headRefOid?: string; state?: string };
      if (pr.state?.toUpperCase() !== "OPEN") return undefined;
      if (!pr.headRefOid || pr.headRefOid !== issue.lastGitHubFailureHeadSha) return undefined;
      return `Repair finished but PR #${issue.prNumber} is still on failing head ${issue.lastGitHubFailureHeadSha.slice(0, 8)}`;
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to verify PR head advancement after repair");
      return undefined;
    }
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
    // Check merged first — a merged PR is both approved and merged,
    // and "done" must take priority over "awaiting_queue".
    if (issue.prState === "merged") return "done";
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return undefined;
}

function resolveRecoverablePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (!issue.prNumber) {
    return resolvePostRunState(issue);
  }
  if (issue.prState === "merged") return "done";
  if (issue.prState === "open") {
    if (issue.lastGitHubFailureSource === "queue_eviction") return "repairing_queue";
    if (issue.prCheckStatus === "failed" || issue.lastGitHubFailureSource === "branch_ci") return "repairing_ci";
    if (issue.prReviewState === "changes_requested") return "changes_requested";
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return resolvePostRunState(issue);
}

function buildFailureContext(issue: Pick<
  IssueRecord,
  | "lastGitHubFailureSource"
  | "lastGitHubFailureHeadSha"
  | "lastGitHubFailureSignature"
  | "lastGitHubFailureCheckName"
  | "lastGitHubFailureCheckUrl"
  | "lastGitHubFailureContextJson"
  | "lastQueueIncidentJson"
>): Record<string, unknown> | undefined {
  const storedFailureContext = parseGitHubFailureContext(issue.lastGitHubFailureContextJson);
  const queueRepairContext = issue.lastQueueIncidentJson
    ? parseStoredQueueRepairContext(issue.lastQueueIncidentJson)
    : undefined;
  if (!queueRepairContext
    && !issue.lastGitHubFailureSource
    && !issue.lastGitHubFailureHeadSha
    && !issue.lastGitHubFailureSignature
    && !issue.lastGitHubFailureCheckName
    && !issue.lastGitHubFailureCheckUrl
    && !storedFailureContext) {
    return undefined;
  }
  return {
    ...(issue.lastGitHubFailureSource ? { failureReason: issue.lastGitHubFailureSource } : {}),
    ...(issue.lastGitHubFailureHeadSha ? { failureHeadSha: issue.lastGitHubFailureHeadSha } : {}),
    ...(issue.lastGitHubFailureSignature ? { failureSignature: issue.lastGitHubFailureSignature } : {}),
    ...(issue.lastGitHubFailureCheckName ? { checkName: issue.lastGitHubFailureCheckName } : {}),
    ...(issue.lastGitHubFailureCheckUrl ? { checkUrl: issue.lastGitHubFailureCheckUrl } : {}),
    ...(storedFailureContext ? storedFailureContext : {}),
    ...(queueRepairContext ? queueRepairContext : {}),
  };
}

function isDuplicateRepairAttempt(
  issue: Pick<IssueRecord, "lastAttemptedFailureHeadSha" | "lastAttemptedFailureSignature">,
  context: Record<string, unknown> | undefined,
): boolean {
  const signature = typeof context?.failureSignature === "string" ? context.failureSignature : undefined;
  const headSha = typeof context?.failureHeadSha === "string"
    ? context.failureHeadSha
    : typeof context?.headSha === "string" ? context.headSha : undefined;
  if (!signature) return false;
  return issue.lastAttemptedFailureSignature === signature
    && (headSha === undefined || issue.lastAttemptedFailureHeadSha === headSha);
}

function appendQueueRepairContext(lines: string[], context?: Record<string, unknown>): void {
  const incidentTitle = typeof context?.incidentTitle === "string" ? context.incidentTitle.trim() : "";
  const incidentSummary = typeof context?.incidentSummary === "string" ? context.incidentSummary.trim() : "";
  const incidentId = typeof context?.incidentId === "string" ? context.incidentId.trim() : "";
  const incidentUrl = typeof context?.incidentUrl === "string" ? context.incidentUrl.trim() : "";
  const incidentContext = context?.incidentContext && typeof context.incidentContext === "object"
    ? context.incidentContext as Record<string, unknown>
    : undefined;
  const failureClass = typeof incidentContext?.failureClass === "string" ? incidentContext.failureClass : "";
  const baseSha = typeof incidentContext?.baseSha === "string" ? incidentContext.baseSha : "";
  const prHeadSha = typeof incidentContext?.prHeadSha === "string" ? incidentContext.prHeadSha : "";
  const baseBranch = typeof incidentContext?.baseBranch === "string" ? incidentContext.baseBranch : "";
  const branch = typeof incidentContext?.branch === "string" ? incidentContext.branch : "";
  const queuePosition = typeof incidentContext?.queuePosition === "number" ? String(incidentContext.queuePosition) : "";
  const conflictFiles = Array.isArray(incidentContext?.conflictFiles)
    ? incidentContext.conflictFiles.filter((entry): entry is string => typeof entry === "string")
    : [];
  const failedChecks = Array.isArray(incidentContext?.failedChecks)
    ? incidentContext.failedChecks
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        name: typeof entry.name === "string" ? entry.name : "unknown",
        conclusion: typeof entry.conclusion === "string" ? entry.conclusion : "unknown",
        ...(typeof entry.url === "string" ? { url: entry.url } : {}),
      }))
    : [];
  const retryHistory = Array.isArray(incidentContext?.retryHistory)
    ? incidentContext.retryHistory
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        at: typeof entry.at === "string" ? entry.at : "unknown",
        baseSha: typeof entry.baseSha === "string" ? entry.baseSha : "unknown",
        outcome: typeof entry.outcome === "string" ? entry.outcome : "unknown",
      }))
    : [];

  if (!incidentTitle && !incidentSummary && !incidentId && !incidentUrl && !failureClass && !baseSha && !prHeadSha
    && !queuePosition && conflictFiles.length === 0 && failedChecks.length === 0 && retryHistory.length === 0) {
    return;
  }

  lines.push("## Queue Incident Context", "");
  if (incidentTitle) lines.push(`Incident: ${incidentTitle}`);
  if (incidentId) lines.push(`Incident ID: ${incidentId}`);
  if (incidentUrl) lines.push(`Incident URL: ${incidentUrl}`);
  if (incidentSummary) lines.push("", incidentSummary, "");
  if (failureClass) lines.push(`Failure class: ${failureClass}`);
  if (baseBranch) lines.push(`Base branch: ${baseBranch}`);
  if (baseSha) lines.push(`Base SHA: ${baseSha}`);
  if (branch) lines.push(`Queue branch: ${branch}`);
  if (prHeadSha) lines.push(`Queue branch head SHA: ${prHeadSha}`);
  if (queuePosition) lines.push(`Queue position at eviction: ${queuePosition}`);

  if (conflictFiles.length > 0) {
    lines.push("", "Conflicting files:");
    for (const file of conflictFiles) lines.push(`- ${file}`);
  }

  if (failedChecks.length > 0) {
    lines.push("", "Failed checks:");
    for (const check of failedChecks) {
      lines.push(`- ${check.name} (${check.conclusion})${check.url ? ` ${check.url}` : ""}`);
    }
  }

  if (retryHistory.length > 0) {
    lines.push("", "Retry history:");
    for (const retry of retryHistory) {
      lines.push(`- ${retry.at}: ${retry.outcome} on base ${retry.baseSha}`);
    }
  }

  lines.push("");
}
