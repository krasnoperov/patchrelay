import type { IssueRecord } from "./db-types.ts";
import { resolveFactoryStateFromGitHub, type FactoryState } from "./factory-state.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import {
  resolveMergeQueueProtocol,
} from "./merge-queue-protocol.ts";
import { isIssueTerminal } from "./pr-state.ts";
import type { ProjectConfig } from "./workflow-types.ts";

const DEFAULT_GATE_CHECK_NAMES = ["verify", "tests"];

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

export function canClearFailureProvenance(issue: IssueRecord, event: NormalizedGitHubEvent, project: ProjectConfig | undefined): boolean {
  if (event.triggerEvent !== "check_passed") return true;
  if (isQueueEvictionFailure(issue, event, project)) {
    return !issue.lastGitHubFailureHeadSha || issue.lastGitHubFailureHeadSha === event.headSha;
  }
  if (!isGateCheckEvent(event, project)) {
    return true;
  }
  if (isStaleGateEvent(issue, event)) {
    return false;
  }
  return !issue.lastGitHubFailureHeadSha || issue.lastGitHubFailureHeadSha === event.headSha;
}

export function resolveGitHubFactoryStateForEvent(
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
): FactoryState | undefined {
  if (event.triggerEvent === "pr_closed") {
    return undefined;
  }

  const effectiveCurrentState =
    (issue.factoryState === "awaiting_input" || issue.factoryState === "delegated")
    && (event.prState === "open" || event.prNumber !== undefined)
      ? "pr_open"
      : issue.factoryState;

  if (
    event.triggerEvent === "check_failed"
    && isQueueEvictionFailure(issue, event, project)
    && issue.prState === "open"
    && issue.activeRunId === undefined
    && !isIssueTerminal(issue)
  ) {
    return "repairing_queue";
  }

  const resolved = resolveFactoryStateFromGitHub(event.triggerEvent, effectiveCurrentState, {
    prReviewState: issue.prReviewState,
    activeRunId: issue.activeRunId,
  });
  if (resolved !== undefined) {
    return resolved;
  }
  if (effectiveCurrentState !== issue.factoryState) {
    return effectiveCurrentState;
  }
  return undefined;
}
