import type { IssueMetadata, ProjectConfig, ProjectWorkflowConfig, WorkflowStage } from "./types.ts";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function extractIssuePrefix(identifier?: string): string | undefined {
  const value = identifier?.trim();
  if (!value) {
    return undefined;
  }

  const [prefix] = value.split("-", 1);
  return prefix ? prefix.toUpperCase() : undefined;
}

export function resolveWorkflow(project: ProjectConfig, stateName?: string): ProjectWorkflowConfig | undefined {
  const normalized = normalize(stateName);
  if (!normalized) {
    return undefined;
  }

  return project.workflows.find((workflow) => normalize(workflow.whenState) === normalized);
}

export function resolveWorkflowStage(project: ProjectConfig, stateName?: string): WorkflowStage | undefined {
  return resolveWorkflow(project, stateName)?.id;
}

export function resolveWorkflowById(project: ProjectConfig, workflowId?: string): ProjectWorkflowConfig | undefined {
  const normalized = normalize(workflowId);
  if (!normalized) {
    return undefined;
  }

  return project.workflows.find((workflow) => normalize(workflow.id) === normalized);
}

export function listRunnableStates(project: ProjectConfig): string[] {
  return project.workflows.map((workflow) => workflow.whenState);
}

export function matchesProject(issue: IssueMetadata, project: ProjectConfig): boolean {
  const issuePrefix = extractIssuePrefix(issue.identifier);
  const teamCandidates = [issue.teamId, issue.teamKey].filter((value): value is string => Boolean(value));
  const labelNames = new Set(issue.labelNames.map((label) => label.toLowerCase()));

  const matchesPrefix =
    project.issueKeyPrefixes.length === 0 ||
    (issuePrefix ? project.issueKeyPrefixes.map((value) => value.toUpperCase()).includes(issuePrefix) : false);
  const matchesTeam =
    project.linearTeamIds.length === 0 || teamCandidates.some((candidate) => project.linearTeamIds.includes(candidate));
  const matchesLabel =
    project.allowLabels.length === 0 || project.allowLabels.some((label) => labelNames.has(label.toLowerCase()));

  return matchesPrefix && matchesTeam && matchesLabel;
}
