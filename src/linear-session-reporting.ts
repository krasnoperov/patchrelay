import type { IssueRecord } from "./db-types.ts";
import type { CompletionCheckResult } from "./completion-check-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { LinearAgentActivityContent } from "./linear-types.ts";
import { formatRunTypeLabel } from "./agent-session-plan.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";
import { isClosedPrState } from "./pr-state.ts";

function lowerRunTypeLabel(runType: RunType): string {
  return formatRunTypeLabel(runType).toLowerCase();
}

function trimSummary(summary: string | undefined, maxLength = 300): string | undefined {
  const value = sanitizeOperatorFacingText(summary);
  if (!value) {
    return undefined;
  }
  return value.length <= maxLength ? value : `${value.slice(0, maxLength).trimEnd()}...`;
}

function describeNextState(state: FactoryState | undefined, prNumber?: number): string | undefined {
  const prLabel = prNumber ? `PR #${prNumber}` : "the pull request";
  switch (state) {
    case "pr_open":
      return `${prLabel} is ready for review.`;
    case "awaiting_queue":
      return `${prLabel} is approved and back in the merge flow.`;
    case "done":
      return `${prLabel} has merged.`;
    case "awaiting_input":
      return "PatchRelay is waiting for guidance before continuing.";
    case "failed":
      return "PatchRelay needs help to recover this workflow.";
    default:
      return undefined;
  }
}

export function buildDelegationThought(runType: RunType, source: "delegation" | "prompt" = "delegation"): LinearAgentActivityContent {
  const sourceText = source === "prompt" ? "latest instructions" : "delegation";
  return {
    type: "thought",
    body: `PatchRelay received the ${sourceText} and is preparing the ${lowerRunTypeLabel(runType)} workflow.`,
  };
}

export function buildAlreadyRunningThought(runType: RunType): LinearAgentActivityContent {
  return {
    type: "thought",
    body: `PatchRelay is already working on the ${lowerRunTypeLabel(runType)} workflow.`,
  };
}

export function buildPromptDeliveredThought(runType: RunType): LinearAgentActivityContent {
  return {
    type: "thought",
    body: `PatchRelay routed your latest instructions into the active ${lowerRunTypeLabel(runType)} workflow.`,
  };
}

export function buildRunStartedActivity(runType: RunType): LinearAgentActivityContent {
  switch (runType) {
    case "review_fix":
      return { type: "action", action: "Addressing", parameter: "review feedback" };
    case "branch_upkeep":
      return { type: "action", action: "Repairing", parameter: "PR branch upkeep after requested changes" };
    case "ci_repair":
      return { type: "action", action: "Repairing", parameter: "failing CI checks" };
    case "queue_repair":
      return { type: "action", action: "Repairing", parameter: "merge queue failure" };
    case "implementation":
    default:
      return { type: "action", action: "Implementing", parameter: "requested change" };
  }
}

export function buildRunCompletedActivity(params: {
  runType: RunType;
  completionSummary?: string;
  postRunState?: FactoryState;
  prNumber?: number;
}): LinearAgentActivityContent | undefined {
  const prLabel = params.prNumber ? `PR #${params.prNumber}` : "the pull request";
  const summary = trimSummary(params.completionSummary);
  const detail = summary ? ` ${summary}` : "";

  switch (params.runType) {
    case "implementation":
      if (params.postRunState === "pr_open") {
        return {
          type: "response",
          body: `${prLabel} opened:${detail || " Published and ready for review."}`,
        };
      }
      return undefined;
    case "review_fix":
      return {
        type: "response",
        body: `Updated ${prLabel} to address review feedback.${detail}`,
      };
    case "ci_repair":
      return {
        type: "response",
        body: `Updated ${prLabel} after CI repair.${detail}`,
      };
    case "queue_repair":
      return {
        type: "response",
        body: `Updated ${prLabel} after merge-queue repair.${detail}`,
      };
    case "branch_upkeep":
      return undefined;
    default: {
      const label = formatRunTypeLabel(params.runType);
      const nextState = describeNextState(params.postRunState, params.prNumber);
      const lines = [`${label} completed.`];
      if (nextState) {
        lines.push("", nextState);
      }
      if (summary) {
        lines.push("", summary);
      }
      return {
        type: "response",
        body: lines.join("\n"),
      };
    }
  }
}

export function buildRunFailureActivity(runType: RunType, reason?: string): LinearAgentActivityContent {
  const label = formatRunTypeLabel(runType);
  return {
    type: "error",
    body: reason ? `${label} failed.\n\n${reason}` : `${label} failed.`,
  };
}

export function buildCompletionCheckActivity(
  phase: "started" | "continue" | "needs_input" | "done",
  result?: CompletionCheckResult,
): LinearAgentActivityContent {
  switch (phase) {
    case "started":
      return { type: "thought", body: "No PR found; checking the next step." };
    case "continue":
      return { type: "thought", body: "No PR found; PatchRelay is continuing automatically." };
    case "needs_input":
      return {
        type: "response",
        body: result?.question
          ? `PatchRelay needs an answer before it can continue.\n\nQuestion: ${result.question}${result.why ? `\n\nWhy: ${result.why}` : ""}${result.recommendedReply ? `\n\nSuggested reply: ${result.recommendedReply}` : ""}`
          : "PatchRelay needs more input before it can continue.",
      };
    case "done":
      return {
        type: "response",
        body: result?.summary
          ? `Completed without a PR.\n\n${result.summary}`
          : "Completed without a PR.",
      };
  }
}

export function buildStopConfirmationActivity(): LinearAgentActivityContent {
  return {
    type: "response",
    body: "PatchRelay has stopped work as requested. Delegate the issue again or provide new instructions to resume.",
  };
}

export function buildGitHubStateActivity(
  newState: FactoryState,
  event: NormalizedGitHubEvent,
): LinearAgentActivityContent | undefined {
  switch (newState) {
    case "pr_open":
      return undefined;
    case "awaiting_queue":
      return undefined;
    case "changes_requested":
      return undefined;
    case "repairing_ci":
      return undefined;
    case "repairing_queue":
      return undefined;
    case "done":
      return { type: "response", body: `PR merged.${event.prNumber ? ` PR #${event.prNumber}` : ""}` };
    case "failed":
      return { type: "error", body: "The pull request was closed without merging." };
    default:
      return undefined;
  }
}

export function buildMergePrepActivity(step: "auto_merge" | "branch_update" | "conflict" | "blocked" | "fetch_retry" | "push_retry", detail?: string): LinearAgentActivityContent {
  switch (step) {
    case "auto_merge":
      return { type: "action", action: "Enabling", parameter: "auto-merge" };
    case "branch_update":
      return { type: "action", action: "Updating", parameter: detail ? `branch to latest ${detail}` : "branch to latest base" };
    case "conflict":
      return { type: "action", action: "Repairing", parameter: "merge conflict with base branch" };
    case "blocked":
      return { type: "error", body: "Branch is up to date but auto-merge could not be enabled — check repository settings." };
    case "fetch_retry":
      return { type: "thought", body: "Merge prep: fetch failed, will retry." };
    case "push_retry":
      return { type: "thought", body: "Merge prep: push failed, will retry." };
  }
}

export function buildMergePrepEscalationActivity(attempts: number): LinearAgentActivityContent {
  return {
    type: "error",
    body: `Merge preparation failed ${attempts} times due to infrastructure issues. PatchRelay needs human help to continue.`,
  };
}

export function summarizeIssueStateForLinear(
  issue: Pick<IssueRecord, "factoryState" | "prNumber" | "prState" | "prReviewState" | "prCheckStatus" | "delegatedToPatchRelay"> & {
    sessionState?: string | undefined;
    waitingReason?: string | undefined;
  },
): string | undefined {
  switch (issue.sessionState) {
    case "waiting_input":
      return issue.waitingReason ?? (issue.prNumber && !isClosedPrState(issue.prState) ? `PR #${issue.prNumber} is waiting for input.` : "Waiting for input.");
    case "running":
      return issue.waitingReason ?? (issue.prNumber && !isClosedPrState(issue.prState) ? `PR #${issue.prNumber} is actively running.` : "Actively running.");
    case "idle":
      if (!issue.delegatedToPatchRelay && issue.prNumber) {
        break;
      }
      return issue.waitingReason ?? (issue.prNumber ? `PR #${issue.prNumber} is idle.` : "Idle.");
      
    case "done":
      if (issue.prNumber && issue.prState === "merged") return `PR #${issue.prNumber} has merged.`;
      if (issue.prNumber && isClosedPrState(issue.prState)) return `Completed without merging PR #${issue.prNumber}.`;
      return issue.prNumber ? `Completed with PR #${issue.prNumber}.` : "Completed.";
    case "failed":
      return issue.waitingReason ?? (issue.prNumber && !isClosedPrState(issue.prState) ? `PR #${issue.prNumber} needs help to recover.` : "Needs help to recover.");
  }

  switch (issue.factoryState) {
    case "pr_open":
      if (!issue.delegatedToPatchRelay && issue.prNumber) {
        return `PR #${issue.prNumber} is awaiting review while PatchRelay is paused.`;
      }
      return issue.prNumber ? `PR #${issue.prNumber} is awaiting review.` : "Awaiting review.";
    case "changes_requested":
      if (!issue.delegatedToPatchRelay && issue.prNumber) {
        return `PR #${issue.prNumber} has requested changes while PatchRelay is paused.`;
      }
      return issue.prNumber ? `PR #${issue.prNumber} has requested changes.` : "Requested changes received.";
    case "repairing_ci":
      if (!issue.delegatedToPatchRelay && issue.prNumber) {
        return `PR #${issue.prNumber} has failing CI while PatchRelay is paused.`;
      }
      return issue.prNumber ? `PR #${issue.prNumber} has failing CI.` : "Failing CI.";
    case "awaiting_queue":
      if (!issue.delegatedToPatchRelay && issue.prNumber) {
        return `PR #${issue.prNumber} is approved and awaiting merge while PatchRelay is paused.`;
      }
      return issue.prNumber ? `PR #${issue.prNumber} is approved and awaiting merge.` : "Approved and awaiting merge.";
    case "done":
      if (issue.prNumber && issue.prState === "merged") return `PR #${issue.prNumber} has merged.`;
      if (issue.prNumber && isClosedPrState(issue.prState)) return `Completed without merging PR #${issue.prNumber}.`;
      return issue.prNumber ? `Completed with PR #${issue.prNumber}.` : "Completed.";
    default:
      return undefined;
  }
}
