import type { ProjectConfig, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { resolveWorkflowById } from "./workflow-policy.ts";

const STATUS_MARKER = "<!-- patchrelay:status-comment -->";

export function resolveActiveLinearState(project: ProjectConfig, stage: string): string | undefined {
  return resolveWorkflowById(project, stage)?.activeState;
}

export function resolveFallbackLinearState(project: ProjectConfig, stage: string): string | undefined {
  return resolveWorkflowById(project, stage)?.fallbackState;
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
