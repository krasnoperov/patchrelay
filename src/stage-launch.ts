import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig, StageLaunchPlan, TrackedIssueRecord, WorkflowStage } from "./types.ts";
import type { StageRunRecord, WorkspaceRecord } from "./types.ts";
import { buildCarryForwardPrompt } from "./stage-handoff.ts";
import { listWorkflowStageIds, resolveWorkflowStageConfig } from "./workflow-policy.ts";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

export function isCodexThreadId(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  return !value.startsWith("missing-thread-") && !value.startsWith("launch-failed-");
}

export function buildStageLaunchPlan(
  project: ProjectConfig,
  issue: TrackedIssueRecord,
  stage: WorkflowStage,
  options?: {
    branchName?: string;
    worktreePath?: string;
    previousStageRun?: StageRunRecord;
    workspace?: Pick<WorkspaceRecord, "branchName" | "worktreePath">;
    stageHistory?: StageRunRecord[];
  },
): StageLaunchPlan {
  const workflow = resolveWorkflowStageConfig(project, stage, issue.selectedWorkflowId);
  if (!workflow) {
    throw new Error(`Workflow "${stage}" is not configured for project ${project.id}`);
  }

  const issueRef = sanitizePathSegment(issue.issueKey ?? issue.linearIssueId);
  const slug = issue.title ? slugify(issue.title) : "";
  const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;

  return {
    branchName: options?.branchName ?? `${project.branchPrefix}/${branchSuffix}`,
    worktreePath: options?.worktreePath ?? path.join(project.worktreeRoot, issueRef),
    workflowFile: workflow.workflowFile,
    stage,
    prompt: buildStagePrompt(
      project,
      issue,
      workflow.id,
      workflow.whenState,
      workflow.workflowFile,
      {
        branchName: options?.branchName ?? `${project.branchPrefix}/${branchSuffix}`,
        worktreePath: options?.worktreePath ?? path.join(project.worktreeRoot, issueRef),
        ...(issue.selectedWorkflowId ? { workflowDefinitionId: issue.selectedWorkflowId } : {}),
        ...(options?.previousStageRun ? { previousStageRun: options.previousStageRun } : {}),
        ...(options?.workspace ? { workspace: options.workspace } : {}),
        stageHistory: options?.stageHistory ?? [],
      },
    ),
  };
}

export function buildStagePrompt(
  project: ProjectConfig,
  issue: TrackedIssueRecord,
  stage: WorkflowStage,
  triggerState: string,
  workflowFile: string,
  options?: {
    branchName?: string;
    worktreePath?: string;
    workflowDefinitionId?: string;
    previousStageRun?: StageRunRecord;
    workspace?: Pick<WorkspaceRecord, "branchName" | "worktreePath">;
    stageHistory?: StageRunRecord[];
  },
): string {
  // Prefer workflow file from worktree (has latest main merged), fall back to repo path
  const worktreeWorkflowFile = options?.worktreePath
    ? path.join(options.worktreePath, path.relative(project.repoPath, workflowFile))
    : undefined;
  const resolvedWorkflowFile = worktreeWorkflowFile && existsSync(worktreeWorkflowFile) ? worktreeWorkflowFile : workflowFile;
  const workflowBody = existsSync(resolvedWorkflowFile) ? readFileSync(resolvedWorkflowFile, "utf8").trim() : "";
  const carryForward = buildCarryForwardPrompt({
    project,
    currentStage: stage,
    ...(options?.workflowDefinitionId ? { workflowDefinitionId: options.workflowDefinitionId } : {}),
    ...(options?.previousStageRun ? { previousStageRun: options.previousStageRun } : {}),
    ...(options?.workspace ? { workspace: options.workspace } : {}),
    stageHistory: options?.stageHistory ?? [],
  });
  const availableStages = listWorkflowStageIds(project, options?.workflowDefinitionId).join(", ");

  return [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.issueUrl ? `Linear URL: ${issue.issueUrl}` : undefined,
    issue.currentLinearState ? `Current Linear State: ${issue.currentLinearState}` : undefined,
    `Workflow: ${stage}`,
    `Triggered By State: ${triggerState}`,
    options?.branchName ? `Branch: ${options.branchName}` : undefined,
    options?.worktreePath ? `Worktree: ${options.worktreePath}` : undefined,
    "",
    "Complete only the current workflow stage. Do not invent a new workflow or skip directly to another stage.",
    "If the correct next step is unclear, say so plainly and use `human_needed` as the next likely stage.",
    "",
    carryForward ? "Carry-forward Context:" : undefined,
    carryForward,
    "",
    "Operate only inside the prepared worktree for this issue. Continue the issue lifecycle in this workspace.",
    "Use the repo workflow instructions below for this stage.",
    "End with a short `Stage result:` section in plain text with exactly four bullets:",
    "- what happened",
    "- key facts or artifacts",
    `- Next likely stage: one of ${availableStages}, done, or human_needed`,
    "- what the next stage or human should pay attention to",
    "",
    `Workflow File: ${path.basename(workflowFile)}`,
    workflowBody,
  ]
    .filter(Boolean)
    .join("\n");
}
