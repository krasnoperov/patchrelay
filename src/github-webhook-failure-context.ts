import type { GitHubCiSnapshotRecord, IssueRecord } from "./db-types.ts";
import type { GitHubFailureContextResolver } from "./github-failure-context.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import type { ProjectConfig } from "./workflow-types.ts";

export interface GitHubFailurePromptContext {
  source?: "branch_ci" | "queue_eviction" | undefined;
  repoFullName?: string | undefined;
  capturedAt?: string | undefined;
  headSha?: string | undefined;
  failureHeadSha?: string | undefined;
  failureSignature?: string | undefined;
  checkName?: string | undefined;
  checkUrl?: string | undefined;
  checkDetailsUrl?: string | undefined;
  workflowRunId?: number | undefined;
  workflowName?: string | undefined;
  jobName?: string | undefined;
  stepName?: string | undefined;
  summary?: string | undefined;
  annotations?: string[] | undefined;
}

export function getRelevantGitHubCiSnapshot(
  db: { issues: { getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): GitHubCiSnapshotRecord | undefined } },
  issue: IssueRecord,
  event: NormalizedGitHubEvent,
): GitHubCiSnapshotRecord | undefined {
  const snapshot = db.issues.getLatestGitHubCiSnapshot(issue.projectId, issue.linearIssueId);
  if (!snapshot) return undefined;
  if (snapshot.headSha !== event.headSha) return undefined;
  return snapshot;
}

export function pickPrimaryFailedCheck(snapshot: GitHubCiSnapshotRecord): { name: string; detailsUrl?: string | undefined } | undefined {
  const gateName = snapshot.gateCheckName?.trim().toLowerCase();
  return snapshot.failedChecks.find((entry) => entry.name.trim().toLowerCase() !== gateName)
    ?? snapshot.failedChecks[0];
}

export async function resolveGitHubBranchFailureContext(params: {
  db: { issues: { getLatestGitHubCiSnapshot(projectId: string, linearIssueId: string): GitHubCiSnapshotRecord | undefined } };
  issue: IssueRecord;
  event: NormalizedGitHubEvent;
  project: ProjectConfig | undefined;
  failureContextResolver: GitHubFailureContextResolver;
}): Promise<GitHubFailurePromptContext> {
  const repoFullName = params.project?.github?.repoFullName ?? params.event.repoFullName;
  const snapshot = getRelevantGitHubCiSnapshot(params.db, params.issue, params.event);
  const primaryFailedCheck = snapshot ? pickPrimaryFailedCheck(snapshot) : undefined;
  const context = await params.failureContextResolver.resolve({
    source: "branch_ci",
    repoFullName,
    event: primaryFailedCheck
      ? {
          ...params.event,
          checkName: primaryFailedCheck.name,
          checkUrl: primaryFailedCheck.detailsUrl ?? params.event.checkUrl,
          checkDetailsUrl: primaryFailedCheck.detailsUrl ?? params.event.checkDetailsUrl,
        }
      : params.event,
  });
  return {
    ...(context ? context : {}),
    ...(context?.headSha || params.event.headSha ? { failureHeadSha: context?.headSha ?? params.event.headSha } : {}),
    ...(context?.failureSignature ? { failureSignature: context.failureSignature } : {}),
  };
}

export function buildGitHubQueueFailureContext(
  event: NormalizedGitHubEvent,
  project: ProjectConfig | undefined,
  queueRepairContext?: unknown,
): GitHubFailurePromptContext {
  const repoFullName = event.repoFullName || project?.github?.repoFullName || "";
  const incident = queueRepairContext && typeof queueRepairContext === "object"
    ? queueRepairContext as { incidentSummary?: string; incidentUrl?: string }
    : undefined;
  const summary = typeof incident?.incidentSummary === "string"
    ? incident.incidentSummary
    : event.checkOutputSummary ?? event.checkOutputTitle;
  const failureHeadSha = event.headSha;
  const failureSignature = [
    "queue_eviction",
    failureHeadSha ?? "unknown-sha",
    event.checkName ?? "merge-steward/queue",
  ].join("::");
  return {
    source: "queue_eviction",
    repoFullName,
    capturedAt: new Date().toISOString(),
    ...(failureHeadSha ? { headSha: failureHeadSha, failureHeadSha } : {}),
    ...(event.checkName ? { checkName: event.checkName } : {}),
    ...(event.checkUrl ? { checkUrl: event.checkUrl } : {}),
    ...(event.checkDetailsUrl ? { checkDetailsUrl: event.checkDetailsUrl } : {}),
    ...(summary ? { summary } : {}),
    failureSignature,
  };
}

export function resolveGitHubCheckClass(
  checkName: string | undefined,
  project: ProjectConfig | undefined,
): "code" | "review" | "gate" {
  if (!checkName || !project) return "code";
  if ((project.reviewChecks ?? []).some((name) => checkName.includes(name))) return "review";
  if ((project.gateChecks ?? []).some((name) => checkName.includes(name))) return "gate";
  return "code";
}
