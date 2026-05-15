import type { PatchRelayDatabase } from "../db.ts";
import { appendDelegationObservedEvent, type DelegationAuditHydration } from "../delegation-audit.ts";
import type { IssueMetadata, IssueRecord, ProjectConfig } from "../types.ts";

export function isDelegatedToPatchRelay(
  db: PatchRelayDatabase,
  project: ProjectConfig,
  issue: { delegateId?: string | undefined },
): boolean {
  const installation = db.linearInstallations.getLinearInstallationForProject(project.id);
  if (!installation?.actorId) return false;
  return issue.delegateId === installation.actorId;
}

export interface DelegationTruthInput {
  db: PatchRelayDatabase;
  project: ProjectConfig;
  normalizedIssue: IssueMetadata;
  hydratedIssue: IssueMetadata;
  existingIssue: IssueRecord | undefined;
  triggerEvent: string;
  webhookId: string;
  actorId?: string | undefined;
  hydration: DelegationAuditHydration;
  activeRunId?: number | undefined;
}

/**
 * Resolves whether the issue is currently delegated to PatchRelay, applying
 * the "preserve previous value when the webhook didn't carry a delegate
 * identity" guard so a stale webhook can't accidentally un-delegate the
 * issue. Emits a `delegation_observed` audit entry whenever the resolved
 * value diverges from what we previously stored, so the audit log captures
 * both raw observation and applied decision.
 */
export function resolveDelegationTruth(input: DelegationTruthInput): { delegated: boolean } {
  const previousDelegated = input.existingIssue?.delegatedToPatchRelay;
  const observedDelegated = isDelegatedToPatchRelay(input.db, input.project, input.hydratedIssue);
  const explicitDelegateSignal = input.triggerEvent === "delegateChanged";
  const hasObservedDelegate = input.hydratedIssue.delegateId !== undefined;

  let delegated = observedDelegated;
  let reason = hasObservedDelegate
    ? "delegate_id_present"
    : `missing_delegate_identity_after_${input.hydration}`;

  if (!hasObservedDelegate && !explicitDelegateSignal && previousDelegated !== undefined) {
    delegated = previousDelegated;
    reason = `preserved_previous_delegation_after_${input.hydration}`;
  }

  if (
    previousDelegated !== delegated
    || input.hydration === "live_linear_failed"
    || (!hasObservedDelegate && previousDelegated !== undefined)
  ) {
    appendDelegationObservedEvent(input.db, {
      projectId: input.project.id,
      linearIssueId: input.normalizedIssue.id,
      payload: {
        source: "linear_webhook",
        webhookId: input.webhookId,
        triggerEvent: input.triggerEvent,
        ...(input.actorId ? { actorId: input.actorId } : {}),
        ...(input.hydratedIssue.delegateId ? { observedDelegateId: input.hydratedIssue.delegateId } : {}),
        ...(previousDelegated !== undefined ? { previousDelegatedToPatchRelay: previousDelegated } : {}),
        observedDelegatedToPatchRelay: observedDelegated,
        appliedDelegatedToPatchRelay: delegated,
        hydration: input.hydration,
        ...(input.activeRunId !== undefined ? { activeRunId: input.activeRunId } : {}),
        decision: "none",
        reason,
      },
    });
  }

  return { delegated };
}
