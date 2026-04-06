import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient, CodexNotification } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { BranchOwner, IssueRecord, RunRecord } from "./db-types.ts";
import { ACTIVE_RUN_STATES, TERMINAL_STATES, type FactoryState, type RunType } from "./factory-state.ts";
import { buildHookEnv, runProjectHook } from "./hook-runner.ts";
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
import { WorktreeManager } from "./worktree-manager.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearClientProvider,
} from "./types.ts";
import { resolveAuthoritativeLinearStopState, resolvePreferredCompletedLinearState } from "./linear-workflow.ts";
import { execCommand } from "./utils.ts";
import { getThreadTurns } from "./codex-thread-utils.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";

const DEFAULT_CI_REPAIR_BUDGET = 3;
const DEFAULT_QUEUE_REPAIR_BUDGET = 3;
const DEFAULT_REVIEW_FIX_BUDGET = 3;
const DEFAULT_ZOMBIE_RECOVERY_BUDGET = 5;
const ZOMBIE_RECOVERY_BASE_DELAY_MS = 15_000; // 15s, 30s, 60s, 120s, 240s
const ISSUE_SESSION_LEASE_MS = 10 * 60_000;
const MAX_THREAD_GENERATION_BEFORE_COMPACTION = 4;
const MAX_FOLLOW_UPS_BEFORE_COMPACTION = 4;
import { QueueHealthMonitor } from "./queue-health-monitor.ts";
import { IdleIssueReconciler, resolveBranchOwnerForStateTransition } from "./idle-reconciliation.ts";
import { LinearSessionSync } from "./linear-session-sync.ts";

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

export type ImplementationDeliveryMode = "publish_pr" | "linear_only";

function collectImplementationInstructionText(issue: Pick<IssueRecord, "title" | "description">, context?: Record<string, unknown>, promptText?: string): string {
  const parts: string[] = [];
  if (issue.title) parts.push(issue.title);
  if (issue.description) parts.push(issue.description);
  if (promptText) parts.push(promptText);

  const stringFields = ["promptContext", "promptBody", "operatorPrompt", "userComment"];
  for (const field of stringFields) {
    const value = context?.[field];
    if (typeof value === "string" && value.trim()) {
      parts.push(value);
    }
  }

  if (Array.isArray(context?.followUps)) {
    for (const entry of context.followUps) {
      if (!entry || typeof entry !== "object") continue;
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").toLowerCase();
}

export function resolveImplementationDeliveryMode(
  issue: Pick<IssueRecord, "title" | "description">,
  context?: Record<string, unknown>,
  promptText?: string,
): ImplementationDeliveryMode {
  const instructionText = collectImplementationInstructionText(issue, context, promptText);
  if (!instructionText) return "publish_pr";

  const hasExplicitNoPr = [
    /\bdo not open (?:a |any )?pr\b/,
    /\bdo not open (?:a |any )?pull request\b/,
    /\bno pr is opened\b/,
    /\bpatchrelay should not open a pr\b/,
    /\bwithout opening a pr\b/,
  ].some((pattern) => pattern.test(instructionText));
  const forbidsRepoChanges = [
    /\bdo not make repository changes\b/,
    /\bdo not make repo changes\b/,
    /\bno repository changes\b/,
    /\bno repo changes\b/,
    /\bdo not modify repo files\b/,
  ].some((pattern) => pattern.test(instructionText));
  const planningOnly = [
    /\bplanning\/specification issue only\b/,
    /\bplanning[- ]only\b/,
    /\bspecification[- ]only\b/,
    /\bplanning issue only\b/,
  ].some((pattern) => pattern.test(instructionText));

  if (hasExplicitNoPr || (planningOnly && forbidsRepoChanges)) {
    return "linear_only";
  }
  return "publish_pr";
}

function appendPublicationContract(
  lines: string[],
  runType: RunType,
  issue?: Pick<IssueRecord, "title" | "description">,
  context?: Record<string, unknown>,
): void {
  const deliveryMode = runType === "implementation" && issue
    ? resolveImplementationDeliveryMode(issue, context)
    : "publish_pr";
  if (runType === "implementation" && deliveryMode === "linear_only") {
    lines.push("## Delivery Requirements", "");
    lines.push(
      "This issue is planning/specification only.",
      "Do not modify repo files or open a PR for this issue.",
      "Deliver the result through Linear artifacts such as follow-up issues, documents, and a concise summary.",
      "Leave the worktree clean before stopping.",
      "",
    );
    return;
  }

  lines.push("## Publication Requirements", "");
  if (runType === "implementation") {
    lines.push(
      "Before finishing, publish the result instead of leaving it only in the worktree.",
      "If the worktree already contains relevant changes for this issue, verify them and publish them.",
      "If you changed files for this issue, commit them, push the issue branch, and open or update the PR before stopping.",
      "Do not stop with only local commits or uncommitted changes.",
      "",
    );
    return;
  }

  lines.push(
    "Before finishing, publish the result to the existing PR branch.",
    "If you changed files for this repair, commit them and push the same branch before stopping.",
    "Do not open a new PR.",
    "Do not stop with only local commits or uncommitted changes.",
    "",
  );
}

function buildPromptHeader(issue: IssueRecord): string[] {
  return [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.branchName ? `Branch: ${issue.branchName}` : undefined,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
    "",
  ].filter(Boolean) as string[];
}

function appendTaskObjective(lines: string[], issue: IssueRecord): void {
  const description = issue.description?.trim();
  lines.push("## Task Objective", "");
  lines.push(issue.title || `Complete ${issue.issueKey ?? issue.linearIssueId}.`);
  if (description) {
    lines.push("", description);
  }
  lines.push("");
}

function appendLinearContext(lines: string[], context?: Record<string, unknown>): void {
  const promptContext = typeof context?.promptContext === "string" ? context.promptContext.trim() : "";
  const latestPrompt = typeof context?.promptBody === "string" ? context.promptBody.trim() : "";
  const operatorPrompt = typeof context?.operatorPrompt === "string" ? context.operatorPrompt.trim() : "";
  const userComment = typeof context?.userComment === "string" ? context.userComment.trim() : "";

  if (promptContext) {
    lines.push("## Linear Session Context", "", promptContext, "");
  }
  if (latestPrompt) {
    lines.push("## Latest Human Instruction", "", latestPrompt, "");
  }
  if (operatorPrompt) {
    lines.push("## Operator Prompt", "", operatorPrompt, "");
  }
  if (userComment) {
    lines.push("## Human Follow-up Comment", "", userComment, "");
  }
}

function collectFollowUpInputs(context?: Record<string, unknown>): Array<{ type: string; text: string; author?: string }> {
  const followUps = Array.isArray(context?.followUps) ? context.followUps : [];
  const inputs: Array<{ type: string; text: string; author?: string }> = [];
  for (const entry of followUps) {
    const followUp = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
    const type = typeof followUp?.type === "string" ? followUp.type : "followup";
    const author = typeof followUp?.author === "string" ? followUp.author : undefined;
    const text = typeof followUp?.text === "string" ? followUp.text.trim() : "";
    if (!text) continue;
    inputs.push({ type, text, ...(author ? { author } : {}) });
  }
  return inputs;
}

function resolveFollowUpWhy(runType: RunType, context?: Record<string, unknown>): string {
  const wakeReason = typeof context?.wakeReason === "string" ? context.wakeReason : undefined;
  switch (wakeReason) {
    case "direct_reply":
      return "A human reply arrived for the outstanding question from the previous turn.";
    case "followup_prompt":
      return "A new Linear agent prompt arrived after the previous turn.";
    case "followup_comment":
      return "A human follow-up comment arrived after the previous turn.";
    case "operator_prompt":
      return "An operator supplied new guidance for this issue.";
    case "review_changes_requested":
      return "GitHub review requested changes on the current PR head.";
    case "settled_red_ci":
      return "Required CI settled red for the current PR head.";
    case "merge_steward_incident":
      return "Merge Steward reported an incident on the current PR head.";
    case "delegated":
      return runType === "implementation"
        ? "This is the first implementation turn for the delegated issue."
        : `This turn continues ${runType.replaceAll("_", " ")} work for the delegated issue.`;
    default:
      if (runType === "review_fix") return "This turn continues requested-changes work on the existing PR.";
      if (runType === "ci_repair") return "This turn continues CI repair work on the existing PR.";
      if (runType === "queue_repair") return "This turn continues merge-queue repair work on the existing PR.";
      return "This turn continues implementation on the existing issue session.";
  }
}

function resolveFollowUpAction(runType: RunType, context?: Record<string, unknown>): string {
  if (context?.directReplyMode === true) {
    return "Apply the latest human answer, continue from the current branch/session context, and only ask another question if you are still blocked.";
  }
  if (runType === "review_fix" && context?.branchUpkeepRequired === true) {
    const baseBranch = typeof context.baseBranch === "string" ? context.baseBranch : "main";
    return `Update the existing PR branch onto latest ${baseBranch}, resolve conflicts if needed, rerun narrow verification, and push the same branch.`;
  }
  switch (runType) {
    case "review_fix":
      return "Address the review feedback on the current PR branch, verify the fix, and push the same branch.";
    case "ci_repair":
      return "Fix the failing CI root cause on the current PR branch, verify it locally, and push the same branch.";
    case "queue_repair":
      return "Repair the merge-queue incident on the current PR branch, verify the fix, and push the same branch.";
    case "implementation":
    default:
      return "Continue from the latest branch state, incorporate the new input, and publish updates to the existing issue branch if you make changes.";
  }
}

function hasAuthoritativeGitHubFacts(issue: IssueRecord, runType: RunType, context?: Record<string, unknown>): boolean {
  return issue.prNumber !== undefined
    || issue.prHeadSha !== undefined
    || runType !== "implementation"
    || typeof context?.failureHeadSha === "string"
    || typeof context?.failingHeadSha === "string"
    || typeof context?.mergeStateStatus === "string"
    || typeof context?.checkName === "string"
    || typeof context?.reviewerName === "string";
}

function appendAuthoritativeGitHubFacts(
  lines: string[],
  issue: IssueRecord,
  runType: RunType,
  context?: Record<string, unknown>,
): void {
  if (!hasAuthoritativeGitHubFacts(issue, runType, context)) {
    return;
  }

  const prNumber = issue.prNumber !== undefined ? `#${issue.prNumber}` : undefined;
  const headSha = typeof context?.failureHeadSha === "string"
    ? context.failureHeadSha
    : typeof context?.failingHeadSha === "string"
    ? context.failingHeadSha
    : issue.prHeadSha;
  const mergeStateStatus = typeof context?.mergeStateStatus === "string" ? context.mergeStateStatus : undefined;
  const baseBranch = typeof context?.baseBranch === "string" ? context.baseBranch : undefined;
  const checkName = typeof context?.checkName === "string" ? context.checkName : undefined;
  const jobName = typeof context?.jobName === "string" ? context.jobName : undefined;
  const stepName = typeof context?.stepName === "string" ? context.stepName : undefined;
  const reviewerName = typeof context?.reviewerName === "string" ? context.reviewerName : undefined;
  const reviewBody = typeof context?.reviewBody === "string" ? context.reviewBody.trim() : "";
  const summary = typeof context?.summary === "string" ? context.summary : undefined;

  lines.push("## Authoritative GitHub Facts", "");
  if (prNumber) {
    lines.push(`- Current PR: ${prNumber}`);
  }
  if (headSha) {
    lines.push(`- Current relevant head SHA: ${headSha}`);
  }
  if (issue.prReviewState) {
    lines.push(`- Current review state: ${issue.prReviewState}`);
  }
  if (issue.prCheckStatus) {
    lines.push(`- Current check status: ${issue.prCheckStatus}`);
  }
  if (mergeStateStatus) {
    lines.push(`- Merge state against ${baseBranch ?? "base"}: ${mergeStateStatus}`);
  }
  if (checkName) {
    lines.push(`- Relevant check: ${checkName}`);
  }
  if (jobName && jobName !== checkName) {
    lines.push(`- Relevant job: ${jobName}`);
  }
  if (stepName) {
    lines.push(`- Relevant step: ${stepName}`);
  }
  if (reviewerName) {
    lines.push(`- Reviewer: ${reviewerName}`);
  }
  if (summary) {
    lines.push(`- Summary: ${summary}`);
  }
  if (reviewBody) {
    lines.push(`- Review body: ${reviewBody}`);
  }
  lines.push("");
}

function appendFactFreshness(lines: string[], issue: IssueRecord, runType: RunType, context?: Record<string, unknown>): void {
  if (!hasAuthoritativeGitHubFacts(issue, runType, context)) {
    return;
  }
  const hasFreshFacts = context?.githubFactsFresh === true || context?.branchUpkeepRequired === true;
  lines.push("## Fact Freshness", "");
  if (hasFreshFacts) {
    lines.push("GitHub facts below were refreshed immediately before this turn was created.");
  } else {
    lines.push("GitHub facts below came from the triggering event or last known reconciliation state and may now be stale.");
    lines.push("Verify the current PR head, review state, and check state in GitHub before making branch-mutating decisions.");
  }
  lines.push("");
}

function appendFollowUpPromptPrelude(
  lines: string[],
  issue: IssueRecord,
  runType: RunType,
  context?: Record<string, unknown>,
): void {
  lines.push("## Follow-up Turn", "");
  lines.push(`Why this turn exists: ${resolveFollowUpWhy(runType, context)}`);
  lines.push(`Required action now: ${resolveFollowUpAction(runType, context)}`);
  lines.push("");

  appendLinearContext(lines, context);

  const followUps = collectFollowUpInputs(context);
  if (followUps.length > 0) {
    lines.push("## What Changed Since The Last Turn", "");
    for (const followUp of followUps) {
      lines.push(`- ${followUp.type}${followUp.author ? ` from ${followUp.author}` : ""}: ${followUp.text}`);
    }
    lines.push("");
  }

  appendFactFreshness(lines, issue, runType, context);
  appendAuthoritativeGitHubFacts(lines, issue, runType, context);
}

export function buildInitialRunPrompt(issue: IssueRecord, runType: RunType, repoPath: string, context?: Record<string, unknown>): string {
  const lines: string[] = buildPromptHeader(issue);
  appendTaskObjective(lines, issue);
  appendLinearContext(lines, context);

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

  const workflowBody = readWorkflowFile(repoPath, runType);
  if (workflowBody) {
    lines.push(workflowBody);
  } else if (runType === "implementation") {
    lines.push(
      "Implement the Linear issue. Read the issue via MCP for details.",
    );
  }
  appendPublicationContract(lines, runType, issue, context);

  return lines.join("\n");
}

export function buildFollowUpRunPrompt(issue: IssueRecord, runType: RunType, repoPath: string, context?: Record<string, unknown>): string {
  const lines: string[] = buildPromptHeader(issue);
  appendFollowUpPromptPrelude(lines, issue, runType, context);

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

  const workflowBody = readWorkflowFile(repoPath, runType);
  if (workflowBody) {
    lines.push(workflowBody);
  } else if (runType === "implementation") {
    lines.push(
      "Implement the Linear issue. Read the issue via MCP for details.",
    );
  }
  appendPublicationContract(lines, runType, issue, context);

  return lines.join("\n");
}

function shouldBuildFollowUpPrompt(runType: RunType, context?: Record<string, unknown>): boolean {
  if (context?.followUpMode) return true;
  if (runType !== "implementation") return true;
  const wakeReason = typeof context?.wakeReason === "string" ? context.wakeReason : undefined;
  return Boolean(wakeReason && wakeReason !== "delegated");
}

export function buildRunPrompt(issue: IssueRecord, runType: RunType, repoPath: string, context?: Record<string, unknown>): string {
  if (shouldBuildFollowUpPrompt(runType, context)) {
    return buildFollowUpRunPrompt(issue, runType, repoPath, context);
  }

  return buildInitialRunPrompt(issue, runType, repoPath, context);
}

interface PendingRunWake {
  runType: RunType;
  context?: Record<string, unknown> | undefined;
  wakeReason?: string | undefined;
  resumeThread: boolean;
  eventIds: number[];
}

function shouldCompactThread(issue: IssueRecord, threadGeneration: number | undefined, context?: Record<string, unknown>): boolean {
  const followUpCount = typeof context?.followUpCount === "number" ? context.followUpCount : 0;
  return issue.threadId !== undefined
    && (threadGeneration ?? 0) >= MAX_THREAD_GENERATION_BEFORE_COMPACTION
    && followUpCount >= MAX_FOLLOW_UPS_BEFORE_COMPACTION;
}

interface RemotePrState {
  headRefOid?: string;
  state?: string;
  reviewDecision?: string;
  mergeStateStatus?: string;
}

interface PostRunFollowUp {
  pendingRunType: RunType;
  factoryState: FactoryState;
  context?: Record<string, unknown> | undefined;
  summary: string;
}

function isBranchUpkeepRequired(context: Record<string, unknown> | undefined): boolean {
  return context?.branchUpkeepRequired === true;
}

export class RunOrchestrator {
  private readonly worktreeManager: WorktreeManager;
  /** Tracks last probe-failure feed event per issue to avoid spamming the operator feed. */
  private readonly queueHealthMonitor: QueueHealthMonitor;
  private readonly idleReconciler: IdleIssueReconciler;
  readonly linearSync: LinearSessionSync;
  private activeThreadId: string | undefined;
  private readonly workerId = `patchrelay:${process.pid}`;
  private readonly activeSessionLeases = new Map<string, string>();
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
    this.linearSync = new LinearSessionSync(config, db, linearProvider, logger, feed);
    this.idleReconciler = new IdleIssueReconciler(db, config, {
      enqueueIssue: (projectId, issueId) => this.enqueueIssue(projectId, issueId),
    }, logger, feed);
    this.queueHealthMonitor = new QueueHealthMonitor(db, config, {
      advanceIdleIssue: (issue, newState, options) => this.idleReconciler.advanceIdleIssue(issue, newState, options),
    }, logger, feed);
  }

  private resolveRunWake(issue: IssueRecord): PendingRunWake | undefined {
    const sessionWake = this.db.peekIssueSessionWake(issue.projectId, issue.linearIssueId);
    if (sessionWake) {
      return {
        runType: sessionWake.runType,
        context: sessionWake.context,
        wakeReason: sessionWake.wakeReason,
        resumeThread: sessionWake.resumeThread,
        eventIds: sessionWake.eventIds,
      };
    }
    if (!issue.pendingRunType) return undefined;
    const context = issue.pendingRunContextJson
      ? JSON.parse(issue.pendingRunContextJson) as Record<string, unknown>
      : undefined;
    return {
      runType: issue.pendingRunType,
      context,
      resumeThread: false,
      eventIds: [],
    };
  }

  // ─── Run ────────────────────────────────────────────────────────

  async run(item: { projectId: string; issueId: string }): Promise<void> {
    const project = this.config.projects.find((p) => p.id === item.projectId);
    if (!project) return;

    if (this.activeSessionLeases.has(this.issueSessionLeaseKey(item.projectId, item.issueId))) {
      return;
    }

    const issue = this.db.getIssue(item.projectId, item.issueId);
    if (!issue || issue.activeRunId !== undefined) return;
    const issueSession = this.db.getIssueSession(item.projectId, item.issueId);

    const leaseId = this.acquireIssueSessionLease(item.projectId, item.issueId);
    if (!leaseId) {
      this.logger.info({ issueKey: issue.issueKey, projectId: item.projectId }, "Skipped run because another worker holds the session lease");
      return;
    }

    if (issue.prState === "merged") {
      this.db.upsertIssueWithLease(
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, pendingRunType: null, factoryState: "done" as never },
      );
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }

    const wake = this.resolveRunWake(issue);
    if (!wake) {
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }
    const { runType, context, resumeThread } = wake;
    const effectiveContext = runType === "review_fix"
      ? await this.resolveReviewFixWakeContext(issue, context, project)
      : context;
    const isReviewFixBranchUpkeep = runType === "review_fix" && isBranchUpkeepRequired(effectiveContext);

    // Check repair budgets
    if (runType === "ci_repair" && issue.ciRepairAttempts >= DEFAULT_CI_REPAIR_BUDGET) {
      this.escalate(issue, runType, `CI repair budget exhausted (${DEFAULT_CI_REPAIR_BUDGET} attempts)`);
      return;
    }
    if (runType === "queue_repair" && issue.queueRepairAttempts >= DEFAULT_QUEUE_REPAIR_BUDGET) {
      this.escalate(issue, runType, `Queue repair budget exhausted (${DEFAULT_QUEUE_REPAIR_BUDGET} attempts)`);
      return;
    }
    if (runType === "review_fix" && !isReviewFixBranchUpkeep && issue.reviewFixAttempts >= DEFAULT_REVIEW_FIX_BUDGET) {
      this.escalate(issue, runType, `Review fix budget exhausted (${DEFAULT_REVIEW_FIX_BUDGET} attempts)`);
      return;
    }

    // Increment repair counters
    if (runType === "ci_repair") {
      const updated = this.db.upsertIssueWithLease(
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, ciRepairAttempts: issue.ciRepairAttempts + 1 },
      );
      if (!updated) {
        this.releaseIssueSessionLease(item.projectId, item.issueId);
        return;
      }
    }
    if (runType === "queue_repair") {
      const updated = this.db.upsertIssueWithLease(
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, queueRepairAttempts: issue.queueRepairAttempts + 1 },
      );
      if (!updated) {
        this.releaseIssueSessionLease(item.projectId, item.issueId);
        return;
      }
    }
    if (runType === "review_fix" && !isReviewFixBranchUpkeep) {
      const updated = this.db.upsertIssueWithLease(
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, leaseId },
        { projectId: issue.projectId, linearIssueId: issue.linearIssueId, reviewFixAttempts: issue.reviewFixAttempts + 1 },
      );
      if (!updated) {
        this.releaseIssueSessionLease(item.projectId, item.issueId);
        return;
      }
    }

    // Build prompt
    const prompt = buildRunPrompt(issue, runType, project.repoPath, effectiveContext);

    // Resolve workspace
    const issueRef = sanitizePathSegment(issue.issueKey ?? issue.linearIssueId);
    const slug = issue.title ? slugify(issue.title) : "";
    const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;
    const branchName = issue.branchName ?? `${project.branchPrefix}/${branchSuffix}`;
    const worktreePath = issue.worktreePath ?? `${project.worktreeRoot}/${issueRef}`;

    // Claim the run atomically
    const run = this.db.withIssueSessionLease(item.projectId, item.issueId, leaseId, () => {
      const fresh = this.db.getIssue(item.projectId, item.issueId);
      if (!fresh || fresh.activeRunId !== undefined) return undefined;
      const freshWake = this.resolveRunWake(fresh);
      if (!freshWake || freshWake.runType !== runType) return undefined;

      const created = this.db.createRun({
        issueId: fresh.id,
        projectId: item.projectId,
        linearIssueId: item.issueId,
        runType,
        promptText: prompt,
      });
      const failureHeadSha = typeof effectiveContext?.failureHeadSha === "string"
          ? effectiveContext.failureHeadSha
          : typeof effectiveContext?.headSha === "string" ? effectiveContext.headSha : undefined;
      const failureSignature = typeof effectiveContext?.failureSignature === "string" ? effectiveContext.failureSignature : undefined;
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
      this.db.consumeIssueSessionEvents(item.projectId, item.issueId, freshWake.eventIds, created.id);
      this.db.setIssueSessionLastWakeReason(item.projectId, item.issueId, freshWake.wakeReason ?? null);
      this.db.setBranchOwnerWithLease({ projectId: item.projectId, linearIssueId: item.issueId, leaseId }, "patchrelay");
      return created;
    });
    if (!run) {
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      return;
    }

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
    let parentThreadId: string | undefined;
    try {
      // Ensure worktree
      await this.worktreeManager.ensureIssueWorktree(
        project.repoPath,
        project.worktreeRoot,
        worktreePath,
        branchName,
        { allowExistingOutsideRoot: issue.branchName !== undefined },
      );

      // Set bot git identity and push credentials when GitHub App is configured.
      // This ensures commits are authored by and pushes are authenticated as
      // patchrelay[bot], not the system user.
      if (this.botIdentity) {
        const gitBin = this.config.runner.gitBin;
        await execCommand(gitBin, ["-C", worktreePath, "config", "user.name", this.botIdentity.name], { timeoutMs: 5_000 });
        await execCommand(gitBin, ["-C", worktreePath, "config", "user.email", this.botIdentity.email], { timeoutMs: 5_000 });
        // Override credential helper to use the App installation token for git push.
        // The helper script reads the token file and returns it as the password.
        const credentialHelper = `!f() { echo "username=x-access-token"; echo "password=$(cat ${this.botIdentity.tokenFile})"; }; f`;
        await execCommand(gitBin, ["-C", worktreePath, "config", "credential.helper", credentialHelper], { timeoutMs: 5_000 });
      }

      await this.resetWorktreeToTrackedBranch(worktreePath, branchName, issue);

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
      this.assertLaunchLease(run, "before starting the Codex turn");

      // Reuse the existing thread when the wake source is an additive follow-up
      // or when review-fix work benefits from carrying reviewer context forward.
      // If the thread has accumulated many resumptions and batched follow-ups,
      // compact by starting a fresh main thread while keeping a parent link.
      const compactThread = shouldCompactThread(issue, issueSession?.threadGeneration, effectiveContext);
      if (compactThread && issue.threadId) {
        parentThreadId = issue.threadId;
      }
      if (issue.threadId && !compactThread && (resumeThread || runType === "review_fix")) {
        threadId = issue.threadId;
      } else {
        const thread = await this.codex.startThread({ cwd: worktreePath });
        threadId = thread.id;
        this.db.upsertIssueWithLease(
          { projectId: item.projectId, linearIssueId: item.issueId, leaseId },
          { projectId: item.projectId, linearIssueId: item.issueId, threadId },
        );
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
          this.db.upsertIssueWithLease(
            { projectId: item.projectId, linearIssueId: item.issueId, leaseId },
            { projectId: item.projectId, linearIssueId: item.issueId, threadId },
          );
          const turn = await this.codex.startTurn({ threadId, cwd: worktreePath, input: prompt });
          turnId = turn.turnId;
        } else {
          throw turnError;
        }
      }
      this.assertLaunchLease(run, "after starting the Codex turn");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lostLease = error instanceof Error && error.name === "IssueSessionLeaseLostError";
      if (!lostLease) {
        this.db.finishRunWithLease({ projectId: item.projectId, linearIssueId: item.issueId, leaseId }, run.id, {
          status: "failed",
          failureReason: message,
        });
        this.db.upsertIssueWithLease(
          { projectId: item.projectId, linearIssueId: item.issueId, leaseId },
          {
            projectId: item.projectId,
            linearIssueId: item.issueId,
            activeRunId: null,
            factoryState: "failed" as const,
          },
        );
      }
      this.logger.error({ issueKey: issue.issueKey, runType, error: message }, `Failed to launch ${runType} run`);
      const failedIssue = this.db.getIssue(item.projectId, item.issueId) ?? issue;
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(runType, `Failed to start ${lowerCaseFirst(message)}`));
      void this.linearSync.syncSession(failedIssue, { activeRunType: runType });
      this.releaseIssueSessionLease(item.projectId, item.issueId);
      throw error;
    }

    this.assertLaunchLease(run, "before recording the active thread");
    if (!this.db.updateRunThreadWithLease(
      { projectId: run.projectId, linearIssueId: run.linearIssueId, leaseId },
      run.id,
      { threadId, turnId, ...(parentThreadId ? { parentThreadId } : {}) },
    )) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping run thread update after losing issue-session lease");
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Reset zombie recovery counter — this run started successfully
    if (issue.zombieRecoveryAttempts > 0) {
      this.db.upsertIssueWithLease(
        { projectId: item.projectId, linearIssueId: item.issueId, leaseId },
        {
          projectId: item.projectId,
          linearIssueId: item.issueId,
          zombieRecoveryAttempts: 0,
          lastZombieRecoveryAt: null,
        },
      );
    }

    this.logger.info(
      { issueKey: issue.issueKey, runType, threadId, turnId },
      `Started ${runType} run`,
    );

    // Emit Linear activity + plan
    const freshIssue = this.db.getIssue(item.projectId, item.issueId) ?? issue;
    void this.linearSync.emitActivity(freshIssue, buildRunStartedActivity(runType));
    void this.linearSync.syncSession(freshIssue, { activeRunType: runType });
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

  private async resetWorktreeToTrackedBranch(
    worktreePath: string,
    branchName: string,
    issue: Pick<IssueRecord, "issueKey">,
  ): Promise<void> {
    const gitBin = this.config.runner.gitBin;
    const branchFetch = await execCommand(gitBin, ["-C", worktreePath, "fetch", "origin", branchName], { timeoutMs: 60_000 });
    const hasRemoteBranch = branchFetch.exitCode === 0;

    await execCommand(gitBin, ["-C", worktreePath, "rebase", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "merge", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "cherry-pick", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "am", "--abort"], { timeoutMs: 10_000 });
    await execCommand(gitBin, ["-C", worktreePath, "reset", "--hard", "HEAD"], { timeoutMs: 30_000 });
    await execCommand(gitBin, ["-C", worktreePath, "clean", "-fd"], { timeoutMs: 30_000 });

    const checkoutTarget = hasRemoteBranch ? `origin/${branchName}` : branchName;
    const checkoutResult = await execCommand(
      gitBin,
      ["-C", worktreePath, "checkout", "-B", branchName, checkoutTarget],
      { timeoutMs: 30_000 },
    );
    if (checkoutResult.exitCode !== 0) {
      throw new Error(
        `Failed to restore ${branchName} worktree state: ${checkoutResult.stderr?.slice(0, 300) ?? "git checkout failed"}`,
      );
    }

    const resetTarget = hasRemoteBranch ? `origin/${branchName}` : "HEAD";
    const resetResult = await execCommand(gitBin, ["-C", worktreePath, "reset", "--hard", resetTarget], { timeoutMs: 30_000 });
    if (resetResult.exitCode !== 0) {
      throw new Error(
        `Failed to reset ${branchName} worktree state: ${resetResult.stderr?.slice(0, 300) ?? "git reset failed"}`,
      );
    }

    await execCommand(gitBin, ["-C", worktreePath, "clean", "-fd"], { timeoutMs: 30_000 });
    this.logger.debug({ issueKey: issue.issueKey, branchName, hasRemoteBranch }, "Reset issue worktree to tracked branch state");
  }

  private async restoreIdleWorktree(
    issue: Pick<IssueRecord, "issueKey" | "worktreePath" | "branchName">,
  ): Promise<void> {
    if (!issue.worktreePath || !issue.branchName) return;
    try {
      await this.resetWorktreeToTrackedBranch(issue.worktreePath, issue.branchName, issue);
    } catch (error) {
      this.logger.warn(
        {
          issueKey: issue.issueKey,
          branchName: issue.branchName,
          worktreePath: issue.worktreePath,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to restore idle worktree after interrupted run",
      );
    }
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
    if (!this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Ignoring Codex notification after losing issue-session lease");
      return;
    }

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
    this.linearSync.maybeEmitProgress(notification, run);

    // Sync codex plan to Linear session when it updates
    if (notification.method === "turn/plan/updated") {
      const issue = this.db.getIssue(run.projectId, run.linearIssueId);
      if (issue) {
        void this.linearSync.syncCodexPlan(issue, notification.params);
      }
    }

    if (notification.method !== "turn/completed") return;

    const thread = await this.readThreadWithRetry(threadId);
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const completedTurnId = extractTurnId(notification.params);
    const status = resolveRunCompletionStatus(notification.params);

    if (status === "failed") {
      const updated = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, (lease) => {
        this.db.finishRunWithLease(lease, run.id, {
          status: "failed",
          threadId,
          ...(completedTurnId ? { turnId: completedTurnId } : {}),
          failureReason: "Codex reported the turn completed in a failed state",
        });
        this.db.upsertIssueWithLease(lease, {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          factoryState: "failed",
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping failed-turn cleanup after losing issue-session lease");
        this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
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
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.activeThreadId = undefined;
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Complete the run
    const trackedIssue = this.db.issueToTrackedIssue(issue);
    const report = buildStageReport(
      { ...run, status: "completed" },
      trackedIssue,
      thread,
      countEventMethods(this.db.listThreadEvents(run.id)),
    );

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
      void this.linearSync.emitActivity(heldIssue, buildRunFailureActivity(run.runType, verifiedRepairError));
      void this.linearSync.syncSession(heldIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.activeThreadId = undefined;
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }
    const publishedOutcomeError = await this.verifyPublishedRunOutcome(run, freshIssue);
    if (publishedOutcomeError) {
      this.failRunAndClear(run, publishedOutcomeError, "failed");
      const failedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
      this.feed?.publish({
        level: "warn",
        kind: "turn",
        issueKey: freshIssue.issueKey,
        projectId: run.projectId,
        stage: run.runType,
        status: "publish_incomplete",
        summary: publishedOutcomeError,
      });
      void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, publishedOutcomeError));
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      this.linearSync.clearProgress(run.id);
      this.activeThreadId = undefined;
      return;
    }
    const refreshedIssue = await this.refreshIssueAfterReactivePublish(run, freshIssue);
    const postRunFollowUp = await this.resolvePostRunFollowUp(run, refreshedIssue);
    const postRunState = postRunFollowUp?.factoryState ?? resolveCompletedRunState(refreshedIssue, run);

    const completed = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
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
        ...(postRunFollowUp
          ? {
              pendingRunType: postRunFollowUp.pendingRunType,
              pendingRunContextJson: postRunFollowUp.context ? JSON.stringify(postRunFollowUp.context) : null,
            }
          : {}),
        ...(postRunFollowUp ? {} : (postRunState === "awaiting_queue" || postRunState === "done"
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
        : {})),
      });
      return true;
    });
    if (!completed) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping completion writes after losing issue-session lease");
      this.linearSync.clearProgress(run.id);
      this.activeThreadId = undefined;
      this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    if (postRunFollowUp) {
      this.feed?.publish({
        level: "info",
        kind: "stage",
        issueKey: issue.issueKey,
        projectId: run.projectId,
        stage: postRunFollowUp.factoryState,
        status: "follow_up_queued",
        summary: postRunFollowUp.summary,
      });
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
    const updatedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
    const completionSummary = report.assistantMessages.at(-1)?.slice(0, 300) ?? `${run.runType} completed.`;
    void this.linearSync.emitActivity(updatedIssue, buildRunCompletedActivity({
      runType: run.runType,
      completionSummary,
      postRunState: updatedIssue.factoryState,
      ...(updatedIssue.prNumber !== undefined ? { prNumber: updatedIssue.prNumber } : {}),
    }));
    void this.linearSync.syncSession(updatedIssue);
    this.linearSync.clearProgress(run.id);
    this.activeThreadId = undefined;
    this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
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
    await this.queueHealthMonitor.reconcile();
    // Advance issues stuck in pr_open whose stored PR metadata already
    // shows they should transition (e.g. approved PR, missed webhook).
    await this.idleReconciler.reconcile();
    await this.reconcileMergedLinearCompletion();
  }

  private async reconcileMergedLinearCompletion(): Promise<void> {
    for (const issue of this.db.listIssues()) {
      if (issue.prState !== "merged") continue;
      if (issue.currentLinearStateType?.trim().toLowerCase() === "completed") continue;

      const linear = await this.linearProvider.forProject(issue.projectId).catch(() => undefined);
      if (!linear) continue;

      try {
        const liveIssue = await linear.getIssue(issue.linearIssueId);
        const targetState = resolvePreferredCompletedLinearState(liveIssue);
        if (!targetState) continue;

        const normalizedCurrent = liveIssue.stateName?.trim().toLowerCase();
        if (normalizedCurrent === targetState.trim().toLowerCase()) {
          this.db.upsertIssue({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
            ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
          });
          continue;
        }

        const updated = await linear.setIssueState(issue.linearIssueId, targetState);
        this.db.upsertIssue({
          projectId: issue.projectId,
          linearIssueId: issue.linearIssueId,
          ...(updated.stateName ? { currentLinearState: updated.stateName } : {}),
          ...(updated.stateType ? { currentLinearStateType: updated.stateType } : {}),
        });
      } catch (error) {
        this.logger.warn(
          { issueKey: issue.issueKey, error: error instanceof Error ? error.message : String(error) },
          "Failed to reconcile merged issue to a completed Linear state",
        );
      }
    }
  }

  // advanceIdleIssue is now on IdleIssueReconciler — delegate for internal callers
  private advanceIdleIssue(
    issue: IssueRecord,
    newState: FactoryState,
    options?: {
      pendingRunType?: RunType;
      pendingRunContext?: Record<string, unknown>;
      clearFailureProvenance?: boolean;
    },
  ): void {
    this.idleReconciler.advanceIdleIssue(issue, newState, options);
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
      const updated = this.withHeldIssueSessionLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.upsertIssueWithLease(lease, {
          projectId: fresh.projectId,
          linearIssueId: fresh.linearIssueId,
          factoryState: "done",
          zombieRecoveryAttempts: 0,
          lastZombieRecoveryAt: null,
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, reason }, "Skipping merged recovery completion after losing issue-session lease");
        this.releaseIssueSessionLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
      this.logger.info({ issueKey: fresh.issueKey, reason }, "Recovery: PR already merged — transitioning to done");
      this.releaseIssueSessionLease(fresh.projectId, fresh.linearIssueId);
      return;
    }

    // Budget check
    const attempts = fresh.zombieRecoveryAttempts + 1;
    if (attempts > DEFAULT_ZOMBIE_RECOVERY_BUDGET) {
      const updated = this.withHeldIssueSessionLease(fresh.projectId, fresh.linearIssueId, (lease) => {
        this.db.upsertIssueWithLease(lease, {
          projectId: fresh.projectId,
          linearIssueId: fresh.linearIssueId,
          factoryState: "escalated",
        });
        return true;
      });
      if (!updated) {
        this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Skipping recovery escalation after losing issue-session lease");
        this.releaseIssueSessionLease(fresh.projectId, fresh.linearIssueId);
        return;
      }
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
      this.releaseIssueSessionLease(fresh.projectId, fresh.linearIssueId);
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
    const requeued = this.withHeldIssueSessionLease(fresh.projectId, fresh.linearIssueId, (lease) => {
      this.db.upsertIssueWithLease(lease, {
        projectId: fresh.projectId,
        linearIssueId: fresh.linearIssueId,
        pendingRunType: runType,
        pendingRunContextJson: null,
        zombieRecoveryAttempts: attempts,
        lastZombieRecoveryAt: new Date().toISOString(),
      });
      return true;
    });
    if (!requeued) {
      this.logger.warn({ issueKey: fresh.issueKey, attempts, reason }, "Skipping recovery re-enqueue after losing issue-session lease");
      this.releaseIssueSessionLease(fresh.projectId, fresh.linearIssueId);
      return;
    }
    this.enqueueIssue(fresh.projectId, fresh.linearIssueId);
    this.logger.info({ issueKey: fresh.issueKey, attempts, reason }, "Recovery: re-enqueued with backoff");
  }

  private async reconcileRun(run: RunRecord): Promise<void> {
    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;
    const recoveryLease = this.claimLeaseForReconciliation(run.projectId, run.linearIssueId);
    if (recoveryLease === "skip") return;

    // If the issue reached a terminal state while this run was active
    // (e.g. pr_merged processed, DB manually edited), just release the run.
    if (TERMINAL_STATES.has(issue.factoryState)) {
      this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
        this.db.finishRun(run.id, { status: "released", failureReason: "Issue reached terminal state during active run" });
        this.db.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.logger.info({ issueKey: issue.issueKey, runId: run.id, factoryState: issue.factoryState }, "Reconciliation: released run on terminal issue");
      const releasedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.syncSession(releasedIssue, { activeRunType: run.runType });
      if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Zombie run: claimed in DB but Codex never started (no thread).
    if (!run.threadId) {
      this.logger.warn(
        { issueKey: issue.issueKey, runId: run.id, runType: run.runType },
        "Zombie run detected (no thread)",
      );
      this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
        this.db.finishRun(run.id, { status: "failed", failureReason: "Zombie: never started (no thread after restart)" });
        this.db.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(issue, run.runType, "zombie");
      const recoveredIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "The Codex turn never started before PatchRelay restarted."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
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
      this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
        this.db.finishRun(run.id, { status: "failed", failureReason: "Stale thread after restart" });
        this.db.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(issue, run.runType, "stale_thread");
      const recoveredIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "PatchRelay lost the active Codex thread after restart and needs to recover."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Check Linear state (non-fatal — token refresh may fail)
    const linear = await this.linearProvider.forProject(run.projectId).catch(() => undefined);
    if (linear) {
      const linearIssue = await linear.getIssue(run.linearIssueId).catch(() => undefined);
      if (linearIssue) {
        const stopState = resolveAuthoritativeLinearStopState(linearIssue);
        if (stopState?.isFinal) {
          this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
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
          const doneIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
          void this.linearSync.syncSession(doneIssue, { activeRunType: run.runType });
          if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
          return;
        }
      }
    }

    const latestTurn = getThreadTurns(thread).at(-1);

    // Handle interrupted turn — fail the run rather than retrying indefinitely.
    // The agent may have partially completed work (commits, PR) before interruption.
    // Reactive loops (CI repair, review fix) will handle follow-up if needed.
    if (latestTurn?.status === "interrupted") {
      this.logger.warn(
        { issueKey: issue.issueKey, runType: run.runType, threadId: run.threadId },
        "Run has interrupted turn — marking as failed",
      );
      // Interrupted runs are not real failures — undo the budget increment.
      const repairedCounters = this.withHeldIssueSessionLease(issue.projectId, issue.linearIssueId, (lease) => {
        if (run.runType === "ci_repair" && issue.ciRepairAttempts > 0) {
          this.db.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            ciRepairAttempts: issue.ciRepairAttempts - 1,
          });
        } else if (run.runType === "queue_repair" && issue.queueRepairAttempts > 0) {
          this.db.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            queueRepairAttempts: issue.queueRepairAttempts - 1,
          });
        } else if (run.runType === "review_fix" && issue.reviewFixAttempts > 0) {
          this.db.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            reviewFixAttempts: issue.reviewFixAttempts - 1,
          });
        }
        if (run.runType === "ci_repair" || run.runType === "queue_repair") {
          this.db.upsertIssueWithLease(lease, {
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            lastAttemptedFailureHeadSha: null,
            lastAttemptedFailureSignature: null,
          });
        }
        return true;
      });
      if (!repairedCounters) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping interrupted-run recovery after losing issue-session lease");
        if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      const recoveredState = resolveRecoverablePostRunState(this.db.getIssue(run.projectId, run.linearIssueId) ?? issue);
      this.failRunAndClear(run, "Codex turn was interrupted", recoveredState);
      await this.restoreIdleWorktree(issue);
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
        void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, "The Codex turn was interrupted."));
      }
      void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
      if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    // Handle completed turn discovered during reconciliation
    if (latestTurn?.status === "completed") {
      const trackedIssue = this.db.issueToTrackedIssue(issue);
      const report = buildStageReport(
        { ...run, status: "completed" },
        trackedIssue,
        thread,
        countEventMethods(this.db.listThreadEvents(run.id)),
      );
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
        const heldIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
        void this.linearSync.emitActivity(heldIssue, buildRunFailureActivity(run.runType, verifiedRepairError));
        void this.linearSync.syncSession(heldIssue, { activeRunType: run.runType });
        if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      const publishedOutcomeError = await this.verifyPublishedRunOutcome(run, freshIssue);
      if (publishedOutcomeError) {
        this.failRunAndClear(run, publishedOutcomeError, "failed");
        this.feed?.publish({
          level: "warn",
          kind: "turn",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: run.runType,
          status: "publish_incomplete",
          summary: publishedOutcomeError,
        });
        const failedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? freshIssue;
        void this.linearSync.emitActivity(failedIssue, buildRunFailureActivity(run.runType, publishedOutcomeError));
        void this.linearSync.syncSession(failedIssue, { activeRunType: run.runType });
        if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      const refreshedIssue = await this.refreshIssueAfterReactivePublish(run, freshIssue);
      const postRunFollowUp = await this.resolvePostRunFollowUp(run, refreshedIssue);
      const postRunState = postRunFollowUp?.factoryState ?? resolveCompletedRunState(refreshedIssue, run);
      const reconciled = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
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
          ...(postRunFollowUp
            ? {
                pendingRunType: postRunFollowUp.pendingRunType,
                pendingRunContextJson: postRunFollowUp.context ? JSON.stringify(postRunFollowUp.context) : null,
              }
            : {}),
          ...(postRunFollowUp ? {} : (postRunState === "awaiting_queue" || postRunState === "done"
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
            : {})),
        });
        return true;
      });
      if (!reconciled) {
        this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping reconciled completion writes after losing issue-session lease");
        if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
        return;
      }
      if (postRunFollowUp) {
        this.feed?.publish({
          level: "info",
          kind: "stage",
          issueKey: issue.issueKey,
          projectId: run.projectId,
          stage: postRunFollowUp.factoryState,
          status: "follow_up_queued",
          summary: postRunFollowUp.summary,
        });
        this.enqueueIssue(run.projectId, run.linearIssueId);
      }
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
      const updatedIssue = this.db.getIssue(run.projectId, run.linearIssueId) ?? refreshedIssue;
      const completionSummary = report.assistantMessages.at(-1)?.slice(0, 300) ?? `${run.runType} completed.`;
      void this.linearSync.emitActivity(updatedIssue, buildRunCompletedActivity({
        runType: run.runType,
        completionSummary,
        postRunState: updatedIssue.factoryState,
        ...(updatedIssue.prNumber !== undefined ? { prNumber: updatedIssue.prNumber } : {}),
      }));
      void this.linearSync.syncSession(updatedIssue);
      if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
      return;
    }

    if (recoveryLease) this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
  }

  // ─── Internal helpers ─────────────────────────────────────────────

  private escalate(issue: IssueRecord, runType: string, reason: string): void {
    this.logger.warn({ issueKey: issue.issueKey, runType, reason }, "Escalating to human");
    const escalated = this.withHeldIssueSessionLease(issue.projectId, issue.linearIssueId, (lease) => {
      if (issue.activeRunId) {
        this.db.finishRunWithLease(lease, issue.activeRunId, { status: "released" });
      }
      this.db.upsertIssueWithLease(lease, {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        pendingRunType: null,
        pendingRunContextJson: null,
        activeRunId: null,
        factoryState: "escalated",
      });
      return true;
    });
    if (!escalated) {
      this.logger.warn({ issueKey: issue.issueKey, runType }, "Skipping escalation write after losing issue-session lease");
      this.releaseIssueSessionLease(issue.projectId, issue.linearIssueId);
      return;
    }
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
    void this.linearSync.emitActivity(escalatedIssue, {
      type: "error",
      body: `PatchRelay needs human help to continue.\n\n${reason}`,
    });
    void this.linearSync.syncSession(escalatedIssue);
    this.releaseIssueSessionLease(issue.projectId, issue.linearIssueId);
  }

  private failRunAndClear(run: RunRecord, message: string, nextState: FactoryState = "failed"): void {
    const updated = this.withHeldIssueSessionLease(run.projectId, run.linearIssueId, () => {
      this.db.finishRun(run.id, { status: "failed", failureReason: message });
      this.db.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        factoryState: nextState,
      });
      const branchOwner = this.resolveBranchOwnerForStateTransition(nextState);
      if (branchOwner) {
        const lease = this.getHeldIssueSessionLease(run.projectId, run.linearIssueId);
        if (lease) {
          this.db.setBranchOwnerWithLease(lease, branchOwner);
        }
      }
      return true;
    });
    if (!updated) {
      this.logger.warn({ runId: run.id, issueId: run.linearIssueId }, "Skipping failure cleanup after losing issue-session lease");
    }
    this.releaseIssueSessionLease(run.projectId, run.linearIssueId);
  }

  private resolveBranchOwnerForStateTransition(newState: FactoryState, pendingRunType?: RunType): BranchOwner | undefined {
    return resolveBranchOwnerForStateTransition(newState, pendingRunType);
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
      const pr = await this.loadRemotePrState(project.github.repoFullName, issue.prNumber);
      if (!pr || pr.state?.toUpperCase() !== "OPEN") return undefined;
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

  private async refreshIssueAfterReactivePublish(run: RunRecord, issue: IssueRecord): Promise<IssueRecord> {
    if (run.runType !== "ci_repair" && run.runType !== "queue_repair") {
      return this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }
    if (!issue.prNumber) {
      return this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }
    const project = this.config.projects.find((entry) => entry.id === run.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) {
        return this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
      }

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      const gateCheckName = project?.gateChecks?.find((entry) => entry.trim())?.trim() ?? "verify";
      const headAdvanced = Boolean(pr.headRefOid && pr.headRefOid !== issue.lastGitHubFailureHeadSha);

      this.upsertIssueIfLeaseHeld(
        run.projectId,
        run.linearIssueId,
        {
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        ...(nextPrState ? { prState: nextPrState } : {}),
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        ...(headAdvanced
          ? {
              prCheckStatus: "pending",
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
              lastGitHubCiSnapshotHeadSha: pr.headRefOid ?? null,
              lastGitHubCiSnapshotGateCheckName: gateCheckName,
              lastGitHubCiSnapshotGateCheckStatus: "pending",
              lastGitHubCiSnapshotJson: null,
              lastGitHubCiSnapshotSettledAt: null,
            }
          : {}),
        },
        "reactive publish refresh",
      );
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to refresh PR state after reactive publish");
    }

    return this.db.getIssue(run.projectId, run.linearIssueId) ?? issue;
  }

  private async loadRemotePrState(
    repoFullName: string,
    prNumber: number,
  ): Promise<RemotePrState | undefined> {
    const { stdout, exitCode } = await execCommand("gh", [
      "pr", "view", String(prNumber),
      "--repo", repoFullName,
      "--json", "headRefOid,state,reviewDecision,mergeStateStatus",
    ], { timeoutMs: 10_000 });
    if (exitCode !== 0) return undefined;
    return JSON.parse(stdout) as RemotePrState;
  }

  private async resolveReviewFixWakeContext(
    issue: IssueRecord,
    context: Record<string, unknown> | undefined,
    project: { github?: { repoFullName?: string; baseBranch?: string } },
  ): Promise<Record<string, unknown> | undefined> {
    if (isBranchUpkeepRequired(context)) {
      return context;
    }
    if (!issue.prNumber || issue.prState !== "open" || issue.prReviewState !== "changes_requested") {
      return context;
    }

    const repoFullName = project.github?.repoFullName;
    if (!repoFullName) {
      return context;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) return context;

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(nextPrState ? { prState: nextPrState } : {}),
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        },
        "review-fix wake refresh",
      );

      if (nextPrState !== "open") return context;
      if (nextReviewState && nextReviewState !== "changes_requested") return context;
      if (!isDirtyMergeStateStatus(pr.mergeStateStatus)) return context;

      return buildReviewFixBranchUpkeepContext(
        issue.prNumber,
        project.github?.baseBranch ?? "main",
        pr,
        context,
      );
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to resolve review-fix wake context");
      return context;
    }
  }

  private async resolvePostRunFollowUp(
    run: Pick<RunRecord, "runType" | "projectId">,
    issue: IssueRecord,
    projectOverride?: { github?: { repoFullName?: string; baseBranch?: string } } | undefined,
  ): Promise<PostRunFollowUp | undefined> {
    if (run.runType !== "review_fix") {
      return undefined;
    }
    if (!issue.prNumber || issue.prState !== "open") {
      return undefined;
    }
    if (issue.prReviewState !== "changes_requested") {
      return undefined;
    }

    const project = projectOverride ?? this.config.projects.find((entry) => entry.id === run.projectId);
    const repoFullName = project?.github?.repoFullName;
    if (!repoFullName) {
      return undefined;
    }

    try {
      const pr = await this.loadRemotePrState(repoFullName, issue.prNumber);
      if (!pr) return undefined;

      const nextPrState = normalizeRemotePrState(pr.state);
      const nextReviewState = normalizeRemoteReviewDecision(pr.reviewDecision);
      this.upsertIssueIfLeaseHeld(
        issue.projectId,
        issue.linearIssueId,
        {
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        ...(nextPrState ? { prState: nextPrState } : {}),
        ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
        ...(nextReviewState ? { prReviewState: nextReviewState } : {}),
        },
        "post-run follow-up refresh",
      );

      if (nextPrState !== "open") return undefined;
      if (nextReviewState && nextReviewState !== "changes_requested") return undefined;
      if (!isDirtyMergeStateStatus(pr.mergeStateStatus)) return undefined;

      return {
        pendingRunType: "review_fix",
        factoryState: "changes_requested",
        context: buildReviewFixBranchUpkeepContext(
          issue.prNumber,
          project?.github?.baseBranch ?? "main",
          pr,
        ),
        summary: `PR #${issue.prNumber} is still dirty after review fix; queued branch upkeep`,
      };
    } catch (error) {
      this.logger.debug({
        issueKey: issue.issueKey,
        prNumber: issue.prNumber,
        error: error instanceof Error ? error.message : String(error),
      }, "Failed to resolve post-run PR upkeep");
      return undefined;
    }
  }

  private async verifyPublishedRunOutcome(
    run: RunRecord,
    issue: IssueRecord,
    projectOverride?: { github?: { repoFullName?: string; baseBranch?: string } } | undefined,
  ): Promise<string | undefined> {
    if (run.runType !== "implementation") {
      return undefined;
    }
    const project = projectOverride ?? this.config.projects.find((entry) => entry.id === run.projectId);
    const baseBranch = project?.github?.baseBranch ?? "main";
    const deliveryMode = resolveImplementationDeliveryMode(issue, undefined, run.promptText);
    if (deliveryMode === "linear_only") {
      if (issue.prNumber !== undefined) {
        return `Planning-only implementation should not open a PR, but PR #${issue.prNumber} was observed`;
      }
      return this.describeLocalImplementationOutcome(issue, baseBranch, deliveryMode);
    }
    if (issue.prNumber && issue.prState && issue.prState !== "closed") {
      return undefined;
    }

    if (project?.github?.repoFullName && issue.branchName) {
      try {
        const { stdout, exitCode } = await execCommand("gh", [
          "pr",
          "list",
          "--repo",
          project.github.repoFullName,
          "--head",
          issue.branchName,
          "--state",
          "all",
          "--json",
          "number,url,state,author,headRefOid",
        ], { timeoutMs: 10_000 });
        if (exitCode === 0) {
          const matches = JSON.parse(stdout) as Array<{
            number?: number;
            url?: string;
            state?: string;
            headRefOid?: string;
            author?: { login?: string };
          }>;
          const pr = matches[0];
          if (pr?.number) {
            this.upsertIssueIfLeaseHeld(
              issue.projectId,
              issue.linearIssueId,
              {
              projectId: issue.projectId,
              linearIssueId: issue.linearIssueId,
              prNumber: pr.number,
              ...(pr.url ? { prUrl: pr.url } : {}),
              ...(pr.state ? { prState: pr.state.toLowerCase() } : {}),
              ...(pr.headRefOid ? { prHeadSha: pr.headRefOid } : {}),
              ...(pr.author?.login ? { prAuthorLogin: pr.author.login } : {}),
              },
              "published PR verification refresh",
            );
            return undefined;
          }
        }
      } catch (error) {
        this.logger.debug({
          issueKey: issue.issueKey,
          branchName: issue.branchName,
          repoFullName: project.github.repoFullName,
          error: error instanceof Error ? error.message : String(error),
        }, "Failed to verify published PR state after implementation");
      }
    }

    const details = await this.describeLocalImplementationOutcome(issue, baseBranch, deliveryMode);
    return details ?? `Implementation completed without opening a PR for branch ${issue.branchName ?? issue.linearIssueId}`;
  }

  private async describeLocalImplementationOutcome(
    issue: IssueRecord,
    baseBranch: string,
    deliveryMode: ImplementationDeliveryMode = "publish_pr",
  ): Promise<string | undefined> {
    if (!issue.worktreePath) {
      return undefined;
    }

    try {
      const status = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "status",
        "--short",
      ], { timeoutMs: 10_000 });
      const dirtyEntries = status.exitCode === 0
        ? status.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
      if (dirtyEntries.length > 0) {
        if (deliveryMode === "linear_only") {
          return `Planning-only implementation should not modify the repo; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
        }
        return `Implementation completed without opening a PR; worktree still has ${dirtyEntries.length} uncommitted change(s)`;
      }
    } catch {
      // Best effort only.
    }

    try {
      const ahead = await execCommand(this.config.runner.gitBin, [
        "-C",
        issue.worktreePath,
        "rev-list",
        "--count",
        `origin/${baseBranch}..HEAD`,
      ], { timeoutMs: 10_000 });
      if (ahead.exitCode === 0) {
        const count = Number(ahead.stdout.trim());
        if (Number.isFinite(count) && count > 0) {
          if (deliveryMode === "linear_only") {
            return `Planning-only implementation should not create repo commits; worktree is ${count} local commit(s) ahead of origin/${baseBranch}`;
          }
          return `Implementation completed with ${count} local commit(s) ahead of origin/${baseBranch} but no PR was observed`;
        }
      }
    } catch {
      // Best effort only.
    }

    return undefined;
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

  private issueSessionLeaseKey(projectId: string, linearIssueId: string): string {
    return `${projectId}:${linearIssueId}`;
  }

  private getHeldIssueSessionLease(projectId: string, linearIssueId: string):
    | { projectId: string; linearIssueId: string; leaseId: string }
    | undefined {
    const leaseId = this.activeSessionLeases.get(this.issueSessionLeaseKey(projectId, linearIssueId));
    if (!leaseId) return undefined;
    return { projectId, linearIssueId, leaseId };
  }

  private withHeldIssueSessionLease<T>(
    projectId: string,
    linearIssueId: string,
    fn: (lease: { projectId: string; linearIssueId: string; leaseId: string }) => T,
  ): T | undefined {
    const lease = this.getHeldIssueSessionLease(projectId, linearIssueId);
    if (!lease) return undefined;
    return this.db.withIssueSessionLease(projectId, linearIssueId, lease.leaseId, () => fn(lease));
  }

  private upsertIssueIfLeaseHeld(
    projectId: string,
    linearIssueId: string,
    params: Parameters<PatchRelayDatabase["upsertIssue"]>[0],
    context: string,
  ): IssueRecord | undefined {
    const lease = this.getHeldIssueSessionLease(projectId, linearIssueId);
    if (!lease) {
      this.logger.warn({ projectId, linearIssueId, context }, "Skipping issue write without a held issue-session lease");
      return undefined;
    }
    const updated = this.db.upsertIssueWithLease(lease, params);
    if (!updated) {
      this.logger.warn({ projectId, linearIssueId, context }, "Skipping issue write after losing issue-session lease");
    }
    return updated;
  }

  private assertLaunchLease(run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">, phase: string): void {
    if (this.heartbeatIssueSessionLease(run.projectId, run.linearIssueId)) {
      return;
    }
    const error = new Error(`Lost issue-session lease ${phase}`);
    error.name = "IssueSessionLeaseLostError";
    this.logger.warn({ runId: run.id, issueId: run.linearIssueId, phase }, "Aborting run launch after losing issue-session lease");
    throw error;
  }

  private acquireIssueSessionLease(projectId: string, linearIssueId: string): string | undefined {
    const leaseId = randomUUID();
    const leasedUntil = new Date(Date.now() + ISSUE_SESSION_LEASE_MS).toISOString();
    const acquired = this.db.acquireIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      workerId: this.workerId,
      leasedUntil,
    });
    if (!acquired) return undefined;
    this.activeSessionLeases.set(this.issueSessionLeaseKey(projectId, linearIssueId), leaseId);
    return leaseId;
  }

  private claimLeaseForReconciliation(projectId: string, linearIssueId: string): boolean | "skip" {
    const key = this.issueSessionLeaseKey(projectId, linearIssueId);
    if (this.activeSessionLeases.has(key)) {
      return "skip";
    }
    const session = this.db.getIssueSession(projectId, linearIssueId);
    if (!session) return "skip";
    const leasedUntilMs = session.leasedUntil ? Date.parse(session.leasedUntil) : undefined;
    if (leasedUntilMs !== undefined && Number.isFinite(leasedUntilMs) && leasedUntilMs > Date.now()) {
      return "skip";
    }
    return this.acquireIssueSessionLease(projectId, linearIssueId) ? true : "skip";
  }

  private heartbeatIssueSessionLease(projectId: string, linearIssueId: string): boolean {
    const key = this.issueSessionLeaseKey(projectId, linearIssueId);
    const leaseId = this.activeSessionLeases.get(key) ?? this.db.getIssueSession(projectId, linearIssueId)?.leaseId;
    if (!leaseId) return false;
    const renewed = this.db.renewIssueSessionLease({
      projectId,
      linearIssueId,
      leaseId,
      leasedUntil: new Date(Date.now() + ISSUE_SESSION_LEASE_MS).toISOString(),
    });
    if (renewed) {
      this.activeSessionLeases.set(key, leaseId);
      return true;
    }
    this.activeSessionLeases.delete(key);
    return false;
  }

  private releaseIssueSessionLease(projectId: string, linearIssueId: string): void {
    const key = this.issueSessionLeaseKey(projectId, linearIssueId);
    const leaseId = this.activeSessionLeases.get(key);
    this.db.releaseIssueSessionLease(projectId, linearIssueId, leaseId);
    this.activeSessionLeases.delete(key);
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

function resolveCompletedRunState(issue: IssueRecord, run: Pick<RunRecord, "runType" | "promptText">): FactoryState | undefined {
  if (run.runType === "implementation" && resolveImplementationDeliveryMode(issue, undefined, run.promptText) === "linear_only") {
    return "done";
  }
  return resolvePostRunState(issue);
}

function resolveRecoverablePostRunState(issue: IssueRecord): FactoryState | undefined {
  if (!issue.prNumber) {
    return resolvePostRunState(issue);
  }
  if (issue.prState === "merged") return "done";
  if (issue.prState === "open") {
    const reactiveIntent = deriveIssueSessionReactiveIntent({
      prNumber: issue.prNumber,
      prState: issue.prState,
      prReviewState: issue.prReviewState,
      prCheckStatus: issue.prCheckStatus,
      latestFailureSource: issue.lastGitHubFailureSource,
    });
    if (reactiveIntent) return reactiveIntent.compatibilityFactoryState;
    if (issue.prReviewState === "approved") return "awaiting_queue";
    return "pr_open";
  }
  return resolvePostRunState(issue);
}

function normalizeRemotePrState(value: string | undefined): "open" | "closed" | "merged" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "OPEN") return "open";
  if (normalized === "CLOSED") return "closed";
  if (normalized === "MERGED") return "merged";
  return undefined;
}

function normalizeRemoteReviewDecision(value: string | undefined): "approved" | "changes_requested" | "commented" | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "APPROVED") return "approved";
  if (normalized === "CHANGES_REQUESTED") return "changes_requested";
  if (normalized === "REVIEW_REQUIRED") return "commented";
  return undefined;
}

function isDirtyMergeStateStatus(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "DIRTY";
}

function buildReviewFixBranchUpkeepContext(
  prNumber: number,
  baseBranch: string,
  pr: RemotePrState,
  context?: Record<string, unknown>,
): Record<string, unknown> {
  const promptContext = [
    `The requested review change is already addressed, but GitHub still reports PR #${prNumber} as ${String(pr.mergeStateStatus)} against latest ${baseBranch}.`,
    `Before stopping, update the existing PR branch onto latest ${baseBranch}, resolve any conflicts, rerun the narrowest relevant verification, and push again.`,
    "Do not stop just because the requested code change is already present.",
  ].join(" ");

  return {
    ...(context ?? {}),
    branchUpkeepRequired: true,
    promptContext,
    ...(pr.mergeStateStatus ? { mergeStateStatus: pr.mergeStateStatus } : {}),
    ...(pr.headRefOid ? { failingHeadSha: pr.headRefOid } : {}),
    baseBranch,
  };
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
