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

export function buildOperatorRetryEvent(issue: IssueRecord, runType: string) {
  if (runType === "queue_repair") {
    const queueIncident = parseObjectJson(issue.lastQueueIncidentJson);
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
    return {
      eventType: "merge_steward_incident" as const,
      eventJson: JSON.stringify({
        ...(queueIncident ?? {}),
        ...(failureContext ?? {}),
        source: "operator_retry",
      }),
      dedupeKey: `operator_retry:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`,
    };
  }

  if (runType === "ci_repair") {
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson);
    return {
      eventType: "settled_red_ci" as const,
      eventJson: JSON.stringify({
        ...(failureContext ?? {}),
        source: "operator_retry",
      }),
      dedupeKey: `operator_retry:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`,
    };
  }

  if (runType === "review_fix" || runType === "branch_upkeep") {
    return {
      eventType: "review_changes_requested" as const,
      eventJson: JSON.stringify({
        reviewBody: runType === "branch_upkeep"
          ? "Operator requested retry of branch upkeep after requested changes."
          : "Operator requested retry of review-fix work.",
        ...(runType === "branch_upkeep" ? { branchUpkeepRequired: true, wakeReason: "branch_upkeep" } : {}),
        source: "operator_retry",
      }),
      dedupeKey: `operator_retry:${runType}:${issue.linearIssueId}:${issue.prHeadSha ?? "unknown-sha"}`,
    };
  }

  return {
    eventType: "delegated" as const,
    eventJson: JSON.stringify({
      promptContext: "Operator requested retry of PatchRelay work.",
      source: "operator_retry",
    }),
    dedupeKey: `operator_retry:implementation:${issue.linearIssueId}`,
  };
}
