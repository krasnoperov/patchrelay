import type { ProjectConfig, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { resolveWorkflowStageConfig } from "./workflow-policy.ts";

const STATUS_MARKER = "<!-- patchrelay:status-comment -->";

function normalizeLinearState(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function resolveActiveLinearState(project: ProjectConfig, stage: string, workflowDefinitionId?: string): string | undefined {
  return resolveWorkflowStageConfig(project, stage, workflowDefinitionId)?.activeState;
}

export function resolveFallbackLinearState(project: ProjectConfig, stage: string, workflowDefinitionId?: string): string | undefined {
  return resolveWorkflowStageConfig(project, stage, workflowDefinitionId)?.fallbackState;
}

export function resolveDoneLinearState(issue: {
  stateName?: string;
  workflowStates: Array<{ name: string; type?: string }>;
}): string | undefined {
  const typedMatch = issue.workflowStates.find((state) => normalizeLinearState(state.type) === "completed");
  if (typedMatch?.name) {
    return typedMatch.name;
  }

  const nameMatch = issue.workflowStates.find((state) => {
    const normalized = normalizeLinearState(state.name);
    return normalized === "done" || normalized === "completed" || normalized === "complete";
  });
  return nameMatch?.name;
}

export function resolveAuthoritativeLinearStopState(issue: {
  stateName?: string;
  workflowStates: Array<{ name: string; type?: string }>;
}): { stateName: string; lifecycleStatus: "completed" | "paused" } | undefined {
  const currentStateName = issue.stateName?.trim();
  const normalizedCurrentState = normalizeLinearState(currentStateName);
  if (!currentStateName || !normalizedCurrentState) {
    return undefined;
  }

  const currentWorkflowState = issue.workflowStates.find((state) => normalizeLinearState(state.name) === normalizedCurrentState);
  if (normalizeLinearState(currentWorkflowState?.type) === "completed") {
    return {
      stateName: currentWorkflowState?.name ?? currentStateName,
      lifecycleStatus: "completed",
    };
  }

  if (normalizedCurrentState === "human needed") {
    return {
      stateName: currentStateName,
      lifecycleStatus: "paused",
    };
  }

  if (normalizedCurrentState === "done" || normalizedCurrentState === "completed" || normalizedCurrentState === "complete") {
    return {
      stateName: currentStateName,
      lifecycleStatus: "completed",
    };
  }

  return undefined;
}

export function buildRunningStatusComment(params: {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  branchName: string;
}): string {
  return [
    STATUS_MARKER,
    `PatchRelay is running the ${params.stageRun.stage} workflow.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Workflow: \`${params.stageRun.stage}\``,
    `- Branch: \`${params.branchName}\``,
    `- Thread: \`${params.stageRun.threadId ?? "starting"}\``,
    `- Turn: \`${params.stageRun.turnId ?? "starting"}\``,
    `- Started: \`${params.stageRun.startedAt}\``,
    "- Status: `working`",
  ].join("\n");
}

export function buildAwaitingHandoffComment(params: {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  activeState: string;
}): string {
  return [
    STATUS_MARKER,
    `PatchRelay finished the ${params.stageRun.stage} workflow, but Linear is still in \`${params.activeState}\`.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Workflow: \`${params.stageRun.stage}\``,
    `- Thread: \`${params.stageRun.threadId ?? "unknown"}\``,
    `- Turn: \`${params.stageRun.turnId ?? "unknown"}\``,
    `- Completed: \`${params.stageRun.endedAt ?? new Date().toISOString()}\``,
    "- Status: `awaiting-final-state`",
    "",
    "The workflow likely finished without moving the issue to its next Linear state. Please review the thread report and update the issue state.",
  ].join("\n");
}

export function buildHumanNeededComment(params: {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
}): string {
  return [
    STATUS_MARKER,
    `PatchRelay finished the ${params.stageRun.stage} workflow and now needs human input.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Workflow: \`${params.stageRun.stage}\``,
    `- Thread: \`${params.stageRun.threadId ?? "unknown"}\``,
    `- Turn: \`${params.stageRun.turnId ?? "unknown"}\``,
    `- Completed: \`${params.stageRun.endedAt ?? new Date().toISOString()}\``,
    "- Status: `human-needed`",
    "",
    "Review the stage report, decide the right next workflow step, and move or re-prompt the issue when ready.",
  ].join("\n");
}

export function buildStageFailedComment(params: {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  message: string;
  fallbackState?: string;
  mode?: "launch" | "failed";
}): string {
  const mode = params.mode ?? "launch";
  return [
    STATUS_MARKER,
    mode === "launch"
      ? `PatchRelay could not start the ${params.stageRun.stage} workflow.`
      : `PatchRelay marked the ${params.stageRun.stage} workflow as failed.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Workflow: \`${params.stageRun.stage}\``,
    `- Started: \`${params.stageRun.startedAt}\``,
    `- Failure: \`${params.message}\``,
    `- Recommended state: \`${params.fallbackState ?? "Human Needed"}\``,
    mode === "launch" ? "- Status: `launch-failed`" : "- Status: `stage-failed`",
  ].join("\n");
}

export function isPatchRelayStatusComment(commentId: string | undefined, body: string | undefined, trackedCommentId?: string): boolean {
  if (trackedCommentId && commentId === trackedCommentId) {
    return true;
  }

  return typeof body === "string" && body.includes(STATUS_MARKER);
}

export function resolveWorkflowLabelNames(
  project: ProjectConfig,
  mode: "working" | "awaitingHandoff",
): { add: string[]; remove: string[] } {
  const working = project.workflowLabels?.working;
  const awaitingHandoff = project.workflowLabels?.awaitingHandoff;

  if (mode === "working") {
    return {
      add: working ? [working] : [],
      remove: awaitingHandoff ? [awaitingHandoff] : [],
    };
  }

  return {
    add: awaitingHandoff ? [awaitingHandoff] : [],
    remove: working ? [working] : [],
  };
}

export function resolveWorkflowLabelCleanup(project: ProjectConfig): { remove: string[] } {
  return {
    remove: [project.workflowLabels?.working, project.workflowLabels?.awaitingHandoff].filter(
      (value): value is string => Boolean(value),
    ),
  };
}
