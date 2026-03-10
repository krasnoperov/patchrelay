import type { IssueMetadata, ProjectConfig, WorkflowStage } from "./types.ts";

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

export function resolveWorkflowStage(project: ProjectConfig, stateName?: string): WorkflowStage | undefined {
  const normalized = normalize(stateName);
  if (!normalized) {
    return undefined;
  }

  if (normalized === normalize(project.workflowStatuses.development)) {
    return "development";
  }
  if (normalized === normalize(project.workflowStatuses.review)) {
    return "review";
  }
  if (normalized === normalize(project.workflowStatuses.deploy)) {
    return "deploy";
  }
  if (project.workflowStatuses.cleanup && normalized === normalize(project.workflowStatuses.cleanup)) {
    return "cleanup";
  }

  return undefined;
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
