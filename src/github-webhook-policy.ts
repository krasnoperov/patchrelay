import type { IssueRecord } from "./db-types.ts";
import { mayClearFailureProvenance } from "./failure-provenance.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import {
  resolveMergeQueueProtocol,
} from "./merge-queue-protocol.ts";
import type { ProjectConfig } from "./workflow-types.ts";

const DEFAULT_GATE_CHECK_NAMES = ["Tests", "verify"];

/**
 * GitHub sends both check_run and check_suite completion events.
 * A single CI run generates many individual check_run events as each job finishes,
 * but PatchRelay should only start ci_repair once the configured gate check
 * has gone terminal for the current PR head SHA. We still treat most check_run
 * events as metadata-only and only react to queue eviction checks or the settled
 * gate check.
 */
export function isMetadataOnlyCheckEvent(event: NormalizedGitHubEvent): boolean {
  return event.eventSource === "check_run"
    && (event.triggerEvent === "check_passed" || event.triggerEvent === "check_failed");
}

export function getGateCheckNames(project: ProjectConfig | undefined): string[] {
  const configured = (project?.gateChecks ?? []).map((entry) => entry.trim()).filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_GATE_CHECK_NAMES;
}

export function getPrimaryGateCheckName(project: ProjectConfig | undefined): string {
  return getGateCheckNames(project)[0] ?? "verify";
}

export function isGateCheckEvent(event: NormalizedGitHubEvent, project: ProjectConfig | undefined): boolean {
  if (event.eventSource !== "check_run" || !event.checkName) return false;
  const normalized = event.checkName.trim().toLowerCase();
  return getGateCheckNames(project).some((entry) => entry.trim().toLowerCase() === normalized);
}

export function deriveImmediatePrCheckStatus(
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
): "pending" | "success" | "failure" | undefined {
  if (event.triggerEvent === "pr_synchronize") {
    return "pending";
  }
  if (event.eventSource !== "check_run") {
    return undefined;
  }
  if (!isGateCheckEvent(event, project)) {
    return undefined;
  }
  if (isStaleGateEvent(issue, event)) {
    return undefined;
  }
  return event.checkStatus;
}

export function isStaleGateEvent(issue: IssueRecord, event: NormalizedGitHubEvent): boolean {
  return Boolean(
    issue.lastGitHubCiSnapshotHeadSha
    && event.headSha
    && issue.lastGitHubCiSnapshotHeadSha !== event.headSha,
  );
}

export function isQueueEvictionFailure(issue: IssueRecord, event: NormalizedGitHubEvent, project: ProjectConfig | undefined): boolean {
  const protocol = resolveMergeQueueProtocol(project);
  return event.eventSource === "check_run"
    && event.checkName === protocol.evictionCheckName;
}

export function isSettledBranchFailure(
  db: { issues: { getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): { headSha?: string | undefined; gateCheckStatus?: string | undefined } | undefined } },
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
): boolean {
  if (event.triggerEvent !== "check_failed" || issue.prState !== "open") return false;
  if (!isGateCheckEvent(event, project)) return false;
  const snapshot = db.issues.getLatestGitHubCiSnapshot(issue.projectId, issue.linearIssueId);
  if (!snapshot || snapshot.headSha !== event.headSha) return false;
  return snapshot?.gateCheckStatus === "failure" && snapshot.headSha === event.headSha;
}

/**
 * Webhook adapter over {@link mayClearFailureProvenance} — translates a
 * normalized GitHub event into the evidence object the shared rule expects.
 * Check events can arrive out of order, so their head SHA only clears
 * provenance when the success covers the recorded failure head; a
 * `pr_synchronize` carries the freshly pushed head, which IS current truth.
 */
export function canClearFailureProvenance(issue: IssueRecord, event: NormalizedGitHubEvent, project: ProjectConfig | undefined): boolean {
  if (event.triggerEvent === "pr_merged" || event.triggerEvent === "pr_closed") {
    return true;
  }
  if (event.triggerEvent === "pr_synchronize") {
    return mayClearFailureProvenance(issue, {
      headSha: event.headSha,
      headIsCurrentTruth: true,
    });
  }
  if (event.triggerEvent !== "check_passed") {
    return true;
  }
  if (isQueueEvictionFailure(issue, event, project)) {
    return mayClearFailureProvenance(issue, {
      headSha: event.headSha,
      evictionCheckSucceeded: true,
    });
  }
  return mayClearFailureProvenance(issue, {
    headSha: event.headSha,
    gateCheckStatus: "success",
  });
}
