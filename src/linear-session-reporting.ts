import type { IssueRecord } from "./db-types.ts";
import type { CompletionCheckResult } from "./completion-check-types.ts";
import { deriveIssuePhase, type IssuePhase } from "./issue-phase.ts";
import type { RunType } from "./run-type.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { LinearAgentActivityContent } from "./linear-types.ts";
import { formatRunTypeLabel } from "./agent-session-plan.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";
import { isClosedPrState } from "./pr-state.ts";
import { derivePrDisplayContext } from "./pr-display-context.ts";

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

function describeNextState(state: IssuePhase | undefined, prNumber?: number): string | undefined {
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

export function buildAgentSessionAcknowledgementThought(): LinearAgentActivityContent {
  return {
    type: "thought",
    body: "PatchRelay received this agent session and is checking the issue state.",
  };
}

export function buildBlockedDelegationActivity(blockedByKeys: string[] = []): LinearAgentActivityContent {
  const blockers = blockedByKeys.filter((key) => key.trim().length > 0);
  const blockerText = blockers.length > 0
    ? ` Waiting on ${blockers.join(", ")}.`
    : " Waiting for blocker issues to complete.";
  return {
    type: "response",
    body: `PatchRelay accepted this delegation and will not start implementation until the issue is unblocked.${blockerText}`,
  };
}

export function buildPromptDeliveredThought(runType: RunType): LinearAgentActivityContent {
  return {
    type: "thought",
    body: `PatchRelay routed your latest instructions into the active ${lowerRunTypeLabel(runType)} workflow; it will fold them in at the next checkpoint.`,
  };
}

export function buildPromptDeliveryFailedActivity(runType: RunType, reason?: string): LinearAgentActivityContent {
  const suffix = reason ? ` ${trimSummary(reason, 180)}` : "";
  return {
    type: "thought",
    body: `PatchRelay could not route your latest instructions into the active ${lowerRunTypeLabel(runType)} workflow.${suffix}`,
  };
}

export function buildFollowupStatusActivity(params: {
  issue: Pick<IssueRecord,
    | "issueKey"
    | "prNumber"
    | "delegatedToPatchRelay"
    | "workflowOutcome"
    | "inputRequestKind"
    | "prState"
    | "prIsDraft"
    | "prReviewState"
    | "prCheckStatus"
    | "lastGitHubFailureSource"
    | "deployStartedAt"
  >;
  statusNote?: string | undefined;
  activeRunType?: RunType | undefined;
  runnableTaskRunType?: RunType | undefined;
  activityType?: "thought" | "response" | undefined;
}): LinearAgentActivityContent {
  const subject = params.issue.issueKey ? `${params.issue.issueKey}` : "this issue";
  const runNote = params.activeRunType
    ? ` Active workflow: ${lowerRunTypeLabel(params.activeRunType)}.`
    : params.runnableTaskRunType ? ` Queued workflow: ${lowerRunTypeLabel(params.runnableTaskRunType)}.` : "";
  const prNote = params.issue.prNumber ? ` PR #${params.issue.prNumber}.` : "";
  const statusNote = params.statusNote ? ` ${params.statusNote}` : "";
  return {
    type: params.activityType ?? "response",
    body: `PatchRelay status: ${subject} is ${formatIssuePhase(deriveIssuePhase({
      ...params.issue,
      activeRunType: params.activeRunType,
      runnableTaskRunType: params.runnableTaskRunType,
    }))}.${prNote}${runNote}${statusNote}`.trim(),
  };
}

export function buildNonActionableFollowupActivity(intent: "status" | "context_only" | "unknown_needs_ack"): LinearAgentActivityContent {
  const body = intent === "status"
    ? "PatchRelay status is available in the current agent session."
    : intent === "context_only"
      ? "PatchRelay recorded this as context and did not start a new run. Ask PatchRelay to continue, retry, or implement when you want work to run."
      : "PatchRelay did not start a run because this did not clearly request work. Ask PatchRelay to continue, retry, or implement when you want work to run.";
  return { type: "response", body };
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

export function buildReviewRoundStartedActivity(params: {
  round: number;
  reviewerName?: string;
  commentCount?: number;
  headSha?: string;
}): LinearAgentActivityContent {
  const reviewer = params.reviewerName ? ` from @${params.reviewerName}` : "";
  const comments = params.commentCount !== undefined
    ? `; ${params.commentCount} inline comment${params.commentCount === 1 ? "" : "s"} captured`
    : "";
  return {
    type: "action",
    action: "Review round",
    parameter: `${params.round}${reviewer}${comments}`,
  };
}

function formatIssuePhase(state: IssuePhase): string {
  return state.replaceAll("_", " ");
}

export function buildRunCompletedActivity(params: {
  runType: RunType;
  completionSummary?: string;
  postRunState?: IssuePhase;
  prNumber?: number;
  prUrl?: string;
  reviewRound?: number;
  steeringDeliveredCount?: number;
  steeringFailedCount?: number;
}): LinearAgentActivityContent | undefined {
  const prLabel = params.prNumber ? `PR #${params.prNumber}` : "the pull request";
  const summary = cleanOutcomeSummary(trimSummary(params.completionSummary));
  const detail = summary ? ` ${summary}` : "";
  const steeringSummary = buildSteeringSummary(params.steeringDeliveredCount, params.steeringFailedCount);

  switch (params.runType) {
    case "implementation":
      if (params.postRunState === "pr_open") {
        const body = `${prLabel} opened:${detail || " Ready for review."}`;
        const bodyWithPr = params.prUrl ? `${body}\n\nPR: ${params.prUrl}` : body;
        return {
          type: "response",
          body: steeringSummary ? `${bodyWithPr}\n\n${steeringSummary}` : bodyWithPr,
        };
      }
      return undefined;
    case "review_fix":
      {
        const lines: string[] = [];
        lines.push(params.reviewRound ? `Review round ${params.reviewRound} completed.` : "Review fix completed.");
        if (steeringSummary) lines.push(steeringSummary);

        const addressed = summary ? `- ${summary}` : "- Review feedback addressed.";
        lines.push("", "Addressed:", addressed);
        return {
          type: "response",
          body: lines.join("\n").trim(),
        };
      }
    case "ci_repair":
      return summary
        ? {
            type: "response",
            body: steeringSummary ? `${summary}\n\n${steeringSummary}` : summary,
          }
        : {
            type: "response",
            body: steeringSummary ? `Updated ${prLabel} after CI repair.\n\n${steeringSummary}` : `Updated ${prLabel} after CI repair.`,
          };
    case "queue_repair":
      return summary
        ? {
            type: "response",
            body: steeringSummary ? `${summary}\n\n${steeringSummary}` : summary,
          }
        : {
            type: "response",
            body: steeringSummary ? `Updated ${prLabel} after merge-queue repair.\n\n${steeringSummary}` : `Updated ${prLabel} after merge-queue repair.`,
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
      if (steeringSummary) {
        lines.push("", steeringSummary);
      }
      return {
        type: "response",
        body: lines.join("\n"),
      };
    }
  }
}

function cleanOutcomeSummary(summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  return summary
    .replace(/\s+PR:\s*https?:\/\/\S+\.?$/i, "")
    .replace(/\s*(?:,?\s*(?:and|then)\s+)?(?:force-)?pushed(?:\s+(?:a\s+)?(?:new\s+)?head|\s+the\s+branch|\s+changes|\s+an?\s+update|\s+the\s+repaired\s+branch)?\.?$/i, ".")
    .replace(/\s*(?:,?\s*(?:and|then)\s+)?published(?:\s+(?:a\s+)?(?:new\s+)?head|\s+the\s+branch|\s+changes|\s+an?\s+update)?\.?$/i, ".")
    .replace(/\.\.+$/, ".")
    .trim();
}

function buildSteeringSummary(delivered = 0, failed = 0): string | undefined {
  if (delivered === 0 && failed === 0) return undefined;
  const parts: string[] = [];
  if (delivered > 0) {
    parts.push(`${delivered} follow-up prompt${delivered === 1 ? "" : "s"} delivered`);
  }
  if (failed > 0) {
    parts.push(`${failed} follow-up delivery failure${failed === 1 ? "" : "s"}`);
  }
  return `Steering: ${parts.join("; ")}.`;
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
  newState: IssuePhase,
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
  issue: Pick<IssueRecord,
    | "prNumber" | "prState" | "prIsDraft" | "prReviewState" | "prCheckStatus" | "delegatedToPatchRelay"
    | "workflowOutcome" | "inputRequestKind" | "lastGitHubFailureSource" | "deployStartedAt"
    | "currentLinearState" | "currentLinearStateType"
  > & {
    sessionState?: string | undefined;
    waitingReason?: string | undefined;
  },
): string | undefined {
  const prContext = derivePrDisplayContext(issue);
  const phase = deriveIssuePhase(issue);
  switch (issue.sessionState) {
    case "waiting_input":
      return issue.waitingReason ?? (issue.prNumber && !isClosedPrState(issue.prState) ? `PR #${issue.prNumber} is waiting for input.` : "Waiting for input.");
    case "running":
      return issue.waitingReason ?? (issue.prNumber && !isClosedPrState(issue.prState) ? `PR #${issue.prNumber} is actively running.` : "Actively running.");
    case "idle":
      if (!issue.delegatedToPatchRelay) {
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

  switch (phase) {
    case "delegated":
      if (prContext.kind === "closed_replacement_pending") {
        return `Queued to replace closed PR #${prContext.prNumber}.`;
      }
      if (prContext.kind === "closed_pr_paused") {
        return `Closed PR #${prContext.prNumber} needs redelegation before replacement.`;
      }
      if (!issue.delegatedToPatchRelay) {
        return "PatchRelay is queued to start work, but automation is paused.";
      }
      return "Queued to start work.";
    case "implementing":
      if (prContext.kind === "closed_replacement_pending") {
        return `Replacing closed PR #${prContext.prNumber} with a fresh PR.`;
      }
      if (prContext.kind === "closed_pr_paused") {
        return `Closed PR #${prContext.prNumber} needs redelegation before replacement.`;
      }
      if (!issue.delegatedToPatchRelay) {
        return "Implementation is paused because the issue is undelegated.";
      }
      return "Implementation in progress.";
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
    case "paused":
      if (issue.prNumber && issue.prReviewState === "approved") {
        return `PR #${issue.prNumber} is approved and awaiting merge while PatchRelay is paused.`;
      }
      if (issue.prNumber && issue.prReviewState === "changes_requested") {
        return `PR #${issue.prNumber} has requested changes while PatchRelay is paused.`;
      }
      if (issue.prNumber) {
        return `PR #${issue.prNumber} is awaiting review while PatchRelay is paused.`;
      }
      return "PatchRelay is queued to start work, but automation is paused.";
    case "done":
      if (issue.prNumber && issue.prState === "merged") return `PR #${issue.prNumber} has merged.`;
      if (issue.prNumber && isClosedPrState(issue.prState)) return `Completed without merging PR #${issue.prNumber}.`;
      return issue.prNumber ? `Completed with PR #${issue.prNumber}.` : "Completed.";
    default:
      return undefined;
  }
}
