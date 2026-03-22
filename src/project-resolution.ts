import type { AppConfig, IssueMetadata, LinearActorMetadata, ProjectConfig, TriggerEvent } from "./types.ts";

function matchesProject(issue: IssueMetadata, project: ProjectConfig): boolean {
  if (project.issueKeyPrefixes.length > 0 && issue.key) {
    const prefix = issue.key.split("-")[0];
    if (prefix && project.issueKeyPrefixes.includes(prefix)) return true;
  }
  if (project.linearTeamIds.length > 0 && issue.teamId) {
    if (project.linearTeamIds.includes(issue.teamId)) return true;
  }
  return false;
}

export function resolveProject(config: AppConfig, issue: IssueMetadata): ProjectConfig | undefined {
  const matches = config.projects.filter((project) => matchesProject(issue, project));

  if (matches.length === 1) {
    return matches[0];
  }

  return undefined;
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
