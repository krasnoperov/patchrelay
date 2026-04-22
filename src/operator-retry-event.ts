import type { IssueRecord } from "./db-types.ts";

function parseObjectJson(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function buildOperatorRetryEvent(issue: IssueRecord, runType: string, source: string = "operator_retry") {
  if (runType === "queue_repair") {
    const queueIncident = parseObjectJson(issue.lastQueueIncidentJson);
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
    return {
      eventType: "merge_steward_incident" as const,
      eventJson: JSON.stringify({
        ...(queueIncident ?? {}),
        ...(failureContext ?? {}),
        source,
      }),
      dedupeKey: `${source}:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`,
    };
  }

  if (runType === "ci_repair") {
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
    return {
      eventType: "settled_red_ci" as const,
      eventJson: JSON.stringify({
        ...(failureContext ?? {}),
        source,
      }),
      dedupeKey: `${source}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`,
    };
  }

  if (runType === "review_fix" || runType === "branch_upkeep") {
    return {
      eventType: "review_changes_requested" as const,
      eventJson: JSON.stringify({
        ...(runType === "branch_upkeep"
          ? { reviewBody: `${humanizeSource(source)} requested retry of branch upkeep after requested changes.` }
          : { promptContext: `${humanizeSource(source)} requested retry of review-fix work.` }),
        ...(runType === "branch_upkeep" ? { branchUpkeepRequired: true, wakeReason: "branch_upkeep" } : {}),
        source,
      }),
      dedupeKey: `${source}:${runType}:${issue.linearIssueId}:${issue.prHeadSha ?? "unknown-sha"}`,
    };
  }

  return {
    eventType: "delegated" as const,
    eventJson: JSON.stringify({
      promptContext: `${humanizeSource(source)} requested PatchRelay work resume.`,
      source,
    }),
    dedupeKey: `${source}:implementation:${issue.linearIssueId}`,
  };
}

function humanizeSource(source: string): string {
  return source.replaceAll("_", " ");
}
