import type { RunType } from "./factory-state.ts";

export interface RequestedChangesWakeIdentityParams {
  linearIssueId: string;
  runType?: Extract<RunType, "review_fix" | "branch_upkeep"> | undefined;
  headSha?: string | undefined;
  reviewCommitId?: string | undefined;
  reviewId?: number | string | undefined;
  reviewerName?: string | undefined;
}

export interface RequestedChangesWakeIdentity {
  dedupeKey: string;
  coalesceKey: string;
  headSha?: string | undefined;
}

const UNKNOWN_HEAD = "unknown-sha";

export function buildRequestedChangesWakeIdentity(
  params: RequestedChangesWakeIdentityParams,
): RequestedChangesWakeIdentity {
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
