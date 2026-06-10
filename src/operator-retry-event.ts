import type { IssueRecord } from "./db-types.ts";
import { buildRequestedChangesWakeIdentity } from "./reactive-wake-keys.ts";
import { tryParseRunContextValue, type RunContext } from "./run-context.ts";

// Boundary over the stored failure/incident columns: malformed JSON or a
// schema-rejected legacy shape degrades to "no context" (pre-existing
// behavior of the old parseObjectJson for malformed JSON; this pure module
// has no logger to warn through).
function parseRunContextColumn(value: string | undefined): RunContext | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? tryParseRunContextValue(parsed) : undefined;
}

export function buildOperatorRetryEvent(issue: IssueRecord, runType: string, source: string = "operator_retry") {
  if (runType === "queue_repair") {
    const queueIncident = parseRunContextColumn(issue.lastQueueIncidentJson);
    const failureContext = parseRunContextColumn(issue.lastGitHubFailureContextJson);
    return {
      eventType: "merge_steward_incident" as const,
      eventJson: JSON.stringify({
        ...queueIncident,
        ...failureContext,
        source,
        requiresFreshHead: true,
        promptContext: [
          "Operator retry is recovering a merge queue rejection on an approved PR.",
          "If the previous repair left the same head SHA in place, merge-steward may still consider it terminally evicted.",
          "Preserve the approved diff, but publish a new head SHA on the existing PR branch before finishing.",
          "If rebasing onto the current base produces no content change, create an empty queue-kick commit.",
        ].join(" "),
      } satisfies RunContext),
      dedupeKey: `${source}:queue_repair:${issue.linearIssueId}:${issue.prHeadSha ?? issue.lastGitHubFailureHeadSha ?? "unknown-sha"}`,
    };
  }

  if (runType === "ci_repair") {
    const failureContext = parseRunContextColumn(issue.lastGitHubFailureContextJson);
    return {
      eventType: "settled_red_ci" as const,
      eventJson: JSON.stringify({
        ...failureContext,
        source,
      } satisfies RunContext),
      dedupeKey: `${source}:ci_repair:${issue.linearIssueId}:${issue.lastGitHubFailureSignature ?? issue.prHeadSha ?? "unknown-sha"}`,
    };
  }

  if (runType === "review_fix" || runType === "branch_upkeep") {
    const identity = buildRequestedChangesWakeIdentity({
      linearIssueId: issue.linearIssueId,
      runType,
      headSha: issue.prHeadSha,
    });
    return {
      eventType: "review_changes_requested" as const,
      eventJson: JSON.stringify({
        requestedChangesCoalesceKey: identity.coalesceKey,
        ...(identity.headSha ? { requestedChangesHeadSha: identity.headSha } : {}),
        ...(runType === "branch_upkeep"
          ? { reviewBody: `${humanizeSource(source)} requested retry of branch upkeep after requested changes.` }
          : { promptContext: `${humanizeSource(source)} requested retry of review-fix work.` }),
        ...(runType === "branch_upkeep" ? { branchUpkeepRequired: true, wakeReason: "branch_upkeep" } : {}),
        source,
      } satisfies RunContext),
      dedupeKey: identity.dedupeKey,
    };
  }

  return {
    eventType: "delegated" as const,
    eventJson: JSON.stringify({
      promptContext: `${humanizeSource(source)} requested PatchRelay work resume.`,
      source,
    } satisfies RunContext),
    dedupeKey: `${source}:implementation:${issue.linearIssueId}`,
  };
}

function humanizeSource(source: string): string {
  return source.replaceAll("_", " ");
}
