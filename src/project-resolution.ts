import type { AppConfig, IssueMetadata, LinearActorMetadata, ProjectConfig, TriggerEvent } from "./types.ts";

function matchesProject(issue: IssueMetadata, project: ProjectConfig): boolean {
  if (project.issueKeyPrefixes.length > 0 && issue.identifier) {
    const prefix = issue.identifier.split("-")[0];
    if (prefix && project.issueKeyPrefixes.includes(prefix)) return true;
  }
  if (project.linearTeamIds.length > 0 && issue.teamId) {
    if (project.linearTeamIds.includes(issue.teamId)) return true;
  }
  return false;
}

export function resolveProject(config: AppConfig, issue: IssueMetadata): ProjectConfig | undefined {
  if (issue.projectId) {
    const projectMatches = config.projects.filter((project) => matchesLinearProject(issue, project));
    if (projectMatches.length === 1) {
      return projectMatches[0];
    }
    if (projectMatches.length > 1) {
      return undefined;
    }
  }

  const matches = config.projects.filter((project) => matchesProject(issue, project));
  if (matches.length === 1) {
    return matches[0];
  }

  return undefined;
}

function matchesLinearProject(issue: IssueMetadata, project: ProjectConfig): boolean {
  if (!issue.projectId || !project.linearProjectIds.includes(issue.projectId)) {
    return false;
  }
  if (project.linearTeamIds.length === 0 || !issue.teamId) {
    return true;
  }
  return project.linearTeamIds.includes(issue.teamId);
}

export function triggerEventAllowed(project: ProjectConfig, triggerEvent: TriggerEvent): boolean {
  return project.triggerEvents.includes(triggerEvent);
}

function normalizeTrustValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export function trustedActorAllowed(project: ProjectConfig, actor?: LinearActorMetadata): boolean {
  const trusted = project.trustedActors;
  if (!trusted) {
    return true;
  }

  const hasRules =
    trusted.ids.length > 0 || trusted.names.length > 0 || trusted.emails.length > 0 || trusted.emailDomains.length > 0;
  if (!hasRules) {
    return true;
  }

  if (!actor) {
    return false;
  }

  const actorId = actor.id?.trim();
  if (actorId && trusted.ids.includes(actorId)) {
    return true;
  }

  const actorName = normalizeTrustValue(actor.name);
  if (actorName && trusted.names.map((value) => value.trim().toLowerCase()).includes(actorName)) {
    return true;
  }

  const actorEmail = normalizeTrustValue(actor.email);
  if (actorEmail && trusted.emails.map((value) => value.trim().toLowerCase()).includes(actorEmail)) {
    return true;
  }

  const actorDomain = actorEmail?.split("@").at(-1);
  if (actorDomain && trusted.emailDomains.map((value) => value.trim().toLowerCase()).includes(actorDomain)) {
    return true;
  }

  return false;
}
