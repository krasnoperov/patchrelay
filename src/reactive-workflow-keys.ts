import type { RunType } from "./factory-state.ts";

export interface RequestedChangesWorkflowIdentityParams {
  linearIssueId: string;
  runType?: Extract<RunType, "review_fix" | "branch_upkeep"> | undefined;
  headSha?: string | undefined;
  reviewCommitId?: string | undefined;
  reviewId?: number | string | undefined;
  reviewerName?: string | undefined;
}

export interface RequestedChangesWorkflowIdentity {
  dedupeKey: string;
  coalesceKey: string;
  headSha?: string | undefined;
}

const UNKNOWN_HEAD = "unknown-sha";

export function buildRequestedChangesWorkflowIdentity(
  params: RequestedChangesWorkflowIdentityParams,
): RequestedChangesWorkflowIdentity {
  const runType = params.runType ?? "review_fix";
  const headSha = params.reviewCommitId ?? params.headSha;
  const coalesceHead = headSha ?? UNKNOWN_HEAD;
  const coalesceKey = `review_changes_requested:${runType}:issue:${params.linearIssueId}:head:${coalesceHead}`;

  if (params.reviewId !== undefined && params.reviewId !== null) {
    return {
      dedupeKey: `review_changes_requested:${runType}:issue:${params.linearIssueId}:review:${params.reviewId}`,
      coalesceKey,
      ...(headSha ? { headSha } : {}),
    };
  }

  if (headSha && params.reviewerName) {
    return {
      dedupeKey: `review_changes_requested:${runType}:issue:${params.linearIssueId}:head:${headSha}:reviewer:${params.reviewerName}`,
      coalesceKey,
      headSha,
    };
  }

  return {
    dedupeKey: coalesceKey,
    coalesceKey,
    ...(headSha ? { headSha } : {}),
  };
}

export function readRequestedChangesCoalesceKey(eventJson: string | undefined): string | undefined {
  if (!eventJson) return undefined;
  try {
    const parsed = JSON.parse(eventJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const value = (parsed as { requestedChangesCoalesceKey?: unknown }).requestedChangesCoalesceKey;
    return typeof value === "string" && value.trim() ? value : undefined;
  } catch {
    return undefined;
  }
}

export function mergeRequestedChangesEventJson(
  existingJson: string | undefined,
  incomingJson: string | undefined,
): string | undefined {
  if (!incomingJson) return existingJson;
  const incoming = parseObject(incomingJson);
  if (!incoming) return existingJson;
  const existing = parseObject(existingJson);
  if (!existing) return incomingJson;
  return JSON.stringify({ ...existing, ...incoming });
}

function parseObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

export type ReactiveWorkflowEventType =
  | "delegated"
  | "review_changes_requested"
  | "settled_red_ci"
  | "merge_steward_incident";

/**
 * Map a run type to the issue-session event type that represents it. Shared by every
 * reconciler that records a reactive workflow intent (idle reconciliation, startup
 * recovery, queue health) so the mapping stays in one place.
 */
export function reactiveWorkflowEventType(runType: RunType): ReactiveWorkflowEventType {
  switch (runType) {
    case "queue_repair":
      return "merge_steward_incident";
    case "ci_repair":
      return "settled_red_ci";
    case "review_fix":
    case "branch_upkeep":
      return "review_changes_requested";
    default:
      return "delegated";
  }
}

/**
 * Build the dedupe key for a CI/queue repair workflow intent. The discriminator prefers the
 * failure signature, then the PR head, then the recorded failure head, falling
 * back to "unknown" — the same precedence every reconciler used independently
 * before this was consolidated (a prior divergence here swallowed fresh repair
 * incidents after the main branch advanced).
 */
export function buildRepairWorkflowDedupeKey(params: {
  scope: string;
  runType: "queue_repair" | "ci_repair";
  linearIssueId: string;
  signature?: string | undefined;
  prHeadSha?: string | undefined;
  failureHeadSha?: string | undefined;
}): string {
  const discriminator = params.signature ?? params.prHeadSha ?? params.failureHeadSha ?? "unknown";
  return `${params.scope}:${params.runType}:${params.linearIssueId}:${discriminator}`;
}
