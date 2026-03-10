import type { ProjectConfig, StageRunRecord, TrackedIssueRecord, WorkflowStage } from "./types.js";

const STATUS_MARKER = "<!-- patchrelay:status-comment -->";

export function resolveActiveLinearState(project: ProjectConfig, stage: WorkflowStage): string | undefined {
  if (stage === "development") {
    return project.workflowStatuses.developmentActive;
  }
  if (stage === "review") {
    return project.workflowStatuses.reviewActive;
  }
  if (stage === "deploy") {
    return project.workflowStatuses.deployActive;
  }
  return project.workflowStatuses.cleanupActive;
}

export function buildRunningStatusComment(params: {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  branchName: string;
}): string {
  return [
    STATUS_MARKER,
    `PatchRelay is running the ${params.stageRun.stage} stage.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Stage: \`${params.stageRun.stage}\``,
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
    `PatchRelay finished the ${params.stageRun.stage} turn, but Linear is still in \`${params.activeState}\`.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Stage: \`${params.stageRun.stage}\``,
    `- Thread: \`${params.stageRun.threadId ?? "unknown"}\``,
    `- Turn: \`${params.stageRun.turnId ?? "unknown"}\``,
    `- Completed: \`${params.stageRun.endedAt ?? new Date().toISOString()}\``,
    "- Status: `awaiting-final-state`",
    "",
    "The agent likely finished work without moving the issue to its next Linear state. Please review the thread report and update the issue state.",
  ].join("\n");
}

export function buildLaunchFailedComment(params: {
  issue: TrackedIssueRecord;
  stageRun: StageRunRecord;
  message: string;
  fallbackState?: string;
}): string {
  return [
    STATUS_MARKER,
    `PatchRelay could not start the ${params.stageRun.stage} stage.`,
    "",
    `- Issue: \`${params.issue.issueKey ?? params.issue.linearIssueId}\``,
    `- Stage: \`${params.stageRun.stage}\``,
    `- Started: \`${params.stageRun.startedAt}\``,
    `- Failure: \`${params.message}\``,
    `- Recommended state: \`${params.fallbackState ?? "Human Needed"}\``,
    "- Status: `launch-failed`",
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
