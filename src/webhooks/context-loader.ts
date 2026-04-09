import { resolveProject } from "../project-resolution.ts";
import {
  hasCompleteIssueContext,
  mergeIssueMetadata,
} from "./decision-helpers.ts";
import type {
  AppConfig,
  LinearClientProvider,
  NormalizedEvent,
  ProjectConfig,
} from "../types.ts";

export class WebhookContextLoader {
  constructor(
    private readonly config: AppConfig,
    private readonly linearProvider: LinearClientProvider,
  ) {}

  async load(
    normalized: NormalizedEvent,
  ): Promise<{ project: ProjectConfig; normalized: NormalizedEvent } | undefined> {
    if (!normalized.issue) {
      return undefined;
    }

    let project = resolveProject(this.config, normalized.issue);
    let hydrated = normalized;
    if (!project) {
      const routed = await this.tryHydrateProjectRoute(normalized);
      if (!routed) {
        return undefined;
      }
      hydrated = routed.normalized;
      project = routed.project;
    }

    return {
      project,
      normalized: await this.hydrateIssueContext(project.id, hydrated),
    };
  }

  private async hydrateIssueContext(projectId: string, normalized: NormalizedEvent): Promise<NormalizedEvent> {
    if (!normalized.issue) return normalized;
    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted" && normalized.entityType !== "Issue") {
      return normalized;
    }
    if (normalized.entityType !== "Issue" && hasCompleteIssueContext(normalized.issue)) return normalized;

    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) return normalized;

    try {
      const liveIssue = await linear.getIssue(normalized.issue.id);
      return { ...normalized, issue: mergeIssueMetadata(normalized.issue, liveIssue) };
    } catch {
      return normalized;
    }
  }

  private async tryHydrateProjectRoute(
    normalized: NormalizedEvent,
  ): Promise<{ project: ProjectConfig; normalized: NormalizedEvent } | undefined> {
    if (!normalized.issue) return undefined;
    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") return undefined;

    for (const candidate of this.config.projects) {
      const linear = await this.linearProvider.forProject(candidate.id);
      if (!linear) continue;
      try {
        const liveIssue = await linear.getIssue(normalized.issue.id);
        const hydrated = { ...normalized, issue: mergeIssueMetadata(normalized.issue, liveIssue) };
        const resolved = resolveProject(this.config, hydrated.issue);
        if (resolved) return { project: resolved, normalized: hydrated };
      } catch {
        // Continue scanning candidate projects until one can resolve the issue route.
      }
    }
    return undefined;
  }
}
