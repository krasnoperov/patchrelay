import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ProjectConfig, StageLaunchPlan, TrackedIssueRecord, WorkflowStage } from "./types.js";

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
): StageLaunchPlan {
  const issueRef = sanitizePathSegment(issue.issueKey ?? issue.linearIssueId);
  const slug = issue.title ? slugify(issue.title) : "";
  const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;
  const workflowFile = project.workflowFiles[stage];

  return {
    branchName: `${project.branchPrefix}/${branchSuffix}`,
    worktreePath: path.join(project.worktreeRoot, issueRef),
    workflowFile,
    stage,
    prompt: buildStagePrompt(issue, stage, workflowFile),
  };
}

export function buildStagePrompt(
  issue: TrackedIssueRecord,
  stage: WorkflowStage,
  workflowFile: string,
): string {
  const workflowBody = existsSync(workflowFile) ? readFileSync(workflowFile, "utf8").trim() : "";
  return [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.issueUrl ? `Linear URL: ${issue.issueUrl}` : undefined,
    issue.currentLinearState ? `Current Linear State: ${issue.currentLinearState}` : undefined,
    `Stage: ${stage}`,
    "",
    "Operate only inside the prepared worktree for this issue. Continue the issue lifecycle in this workspace.",
    "Capture a crisp summary of what you did, what changed, and what remains blocked so PatchRelay can publish a read-only report.",
    "",
    `Workflow File: ${path.basename(workflowFile)}`,
    workflowBody,
  ]
    .filter(Boolean)
    .join("\n");
}
