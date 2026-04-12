import type { PatchRelayDatabase } from "./db.ts";
import type { IssueSessionEventRecord } from "./db-types.ts";

export type DelegationAuditSource =
  | "linear_webhook"
  | "linear_live_refresh"
  | "startup_recovery"
  | "run_reconciler";

export type DelegationAuditHydration =
  | "webhook_only"
  | "live_linear"
  | "live_linear_failed";

export type DelegationAuditDecision =
  | "none"
  | "release_run"
  | "pause_issue"
  | "resume_issue"
  | "clear_pending";

export interface DelegationObservedPayload {
  source: DelegationAuditSource;
  webhookId?: string | undefined;
  triggerEvent?: string | undefined;
  actorId?: string | undefined;
  observedDelegateId?: string | undefined;
  previousDelegatedToPatchRelay?: boolean | undefined;
  observedDelegatedToPatchRelay: boolean;
  appliedDelegatedToPatchRelay: boolean;
  hydration: DelegationAuditHydration;
  activeRunId?: number | undefined;
  decision: DelegationAuditDecision;
  reason?: string | undefined;
}

export interface RunReleasedAuthorityPayload {
  runId: number;
  runType: string;
  localDelegatedToPatchRelay: boolean;
  liveDelegatedToPatchRelay?: boolean | undefined;
  source: DelegationAuditSource;
  reason: string;
}

export function appendDelegationObservedEvent(
  db: PatchRelayDatabase,
  params: {
    projectId: string;
    linearIssueId: string;
    payload: DelegationObservedPayload;
  },
): void {
  db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.projectId, params.linearIssueId, {
    projectId: params.projectId,
    linearIssueId: params.linearIssueId,
    eventType: "delegation_observed",
    eventJson: JSON.stringify(params.payload),
  });
}

export function appendRunReleasedAuthorityEvent(
  db: PatchRelayDatabase,
  params: {
    projectId: string;
    linearIssueId: string;
    payload: RunReleasedAuthorityPayload;
  },
): void {
  db.issueSessions.appendIssueSessionEventRespectingActiveLease(params.projectId, params.linearIssueId, {
    projectId: params.projectId,
    linearIssueId: params.linearIssueId,
    eventType: "run_released_authority",
    eventJson: JSON.stringify(params.payload),
  });
}

export function parseDelegationObservedPayload(
  event: Pick<IssueSessionEventRecord, "eventType" | "eventJson">,
): DelegationObservedPayload | undefined {
  if (event.eventType !== "delegation_observed" || !event.eventJson) {
    return undefined;
  }
  return parseObject(event.eventJson) as DelegationObservedPayload | undefined;
}

export function parseRunReleasedAuthorityPayload(
  event: Pick<IssueSessionEventRecord, "eventType" | "eventJson">,
): RunReleasedAuthorityPayload | undefined {
  if (event.eventType !== "run_released_authority" || !event.eventJson) {
    return undefined;
  }
  return parseObject(event.eventJson) as RunReleasedAuthorityPayload | undefined;
}

function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
