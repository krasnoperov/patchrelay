import type { AppConfig, IssueMetadata, ProjectConfig, TriggerEvent } from "./types.js";

export function resolveProject(config: AppConfig, issue: IssueMetadata): ProjectConfig | undefined {
  if (config.projects.length === 1) {
    const [onlyProject] = config.projects;
    return onlyProject;
  }

  return config.projects.find((project) => {
    const labelNames = new Set(issue.labelNames.map((label) => label.toLowerCase()));
    const matchesLabel =
      project.allowLabels.length === 0 || project.allowLabels.some((label) => labelNames.has(label.toLowerCase()));

    const teamCandidates = [issue.teamId, issue.teamKey].filter((value): value is string => Boolean(value));
    const matchesTeam =
      project.linearTeamIds.length === 0 ||
      teamCandidates.some((candidate) => project.linearTeamIds.includes(candidate));

    return matchesLabel && matchesTeam;
  });
}

export function triggerEventAllowed(project: ProjectConfig, triggerEvent: TriggerEvent): boolean {
  return project.triggerEvents.includes(triggerEvent);
}
