import type { AppConfig, IssueMetadata, ProjectConfig, TriggerEvent } from "./types.js";
import { matchesProject } from "./workflow-policy.js";

export function resolveProject(config: AppConfig, issue: IssueMetadata): ProjectConfig | undefined {
  const matches = config.projects.filter((project) => matchesProject(issue, project));

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0 && config.projects.length === 1) {
    return config.projects[0];
  }

  return undefined;
}

export function triggerEventAllowed(project: ProjectConfig, triggerEvent: TriggerEvent): boolean {
  return project.triggerEvents.includes(triggerEvent);
}
