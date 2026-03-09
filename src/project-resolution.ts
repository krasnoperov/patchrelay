import type { AppConfig, IssueMetadata, ProjectConfig, TriggerEvent } from "./types.js";

function extractIssuePrefix(identifier?: string): string | undefined {
  const value = identifier?.trim();
  if (!value) {
    return undefined;
  }

  const [prefix] = value.split("-", 1);
  return prefix ? prefix.toUpperCase() : undefined;
}

export function resolveProject(config: AppConfig, issue: IssueMetadata): ProjectConfig | undefined {
  const issuePrefix = extractIssuePrefix(issue.identifier);
  const teamCandidates = [issue.teamId, issue.teamKey].filter((value): value is string => Boolean(value));
  const labelNames = new Set(issue.labelNames.map((label) => label.toLowerCase()));

  const matches = config.projects.filter((project) => {
    const matchesPrefix =
      project.issueKeyPrefixes.length === 0 ||
      (issuePrefix ? project.issueKeyPrefixes.map((value) => value.toUpperCase()).includes(issuePrefix) : false);
    const matchesTeam =
      project.linearTeamIds.length === 0 || teamCandidates.some((candidate) => project.linearTeamIds.includes(candidate));
    const matchesLabel =
      project.allowLabels.length === 0 || project.allowLabels.some((label) => labelNames.has(label.toLowerCase()));

    return matchesPrefix && matchesTeam && matchesLabel;
  });

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0 && config.projects.length === 1) {
    return config.projects[0];
  }

  return matches[0];
}

export function triggerEventAllowed(project: ProjectConfig, triggerEvent: TriggerEvent): boolean {
  return project.triggerEvents.includes(triggerEvent);
}

export function resolveDesiredStage(project: ProjectConfig, stateName?: string): ProjectConfig["workflowFiles"][keyof ProjectConfig["workflowFiles"]] | undefined {
  const normalized = stateName?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === project.workflowStatuses.development.trim().toLowerCase()) {
    return project.workflowFiles.development;
  }
  if (normalized === project.workflowStatuses.review.trim().toLowerCase()) {
    return project.workflowFiles.review;
  }
  if (normalized === project.workflowStatuses.deploy.trim().toLowerCase()) {
    return project.workflowFiles.deploy;
  }
  if (project.workflowStatuses.cleanup && normalized === project.workflowStatuses.cleanup.trim().toLowerCase()) {
    return project.workflowFiles.cleanup;
  }

  return undefined;
}
