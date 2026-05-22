import type { IssueRecord } from "./db-types.ts";
import type { IssueStore } from "./db/issue-store.ts";
import type { IssueSessionStore } from "./db/issue-session-store.ts";
import type { RunType } from "./factory-state.ts";
import { deriveIssueSessionReactiveIntent } from "./issue-session.ts";

export interface WorkflowWake {
  eventIds: number[];
  runType: RunType;
  context: Record<string, unknown>;
  wakeReason?: string | undefined;
  resumeThread: boolean;
}

function parseObjectJson(raw: string | undefined): Record<string, unknown> | undefined {
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

function hasUnattemptedFailureSignature(issue: IssueRecord, fallbackHeadSha?: string): boolean {
  const signature = issue.lastGitHubFailureSignature;
  if (!signature) return false;
  const headSha = issue.lastGitHubFailureHeadSha ?? fallbackHeadSha;
  return issue.lastAttemptedFailureSignature !== signature
    || (headSha !== undefined && issue.lastAttemptedFailureHeadSha !== headSha);
}

export function deriveImplicitReactiveWake(issue: IssueRecord):
  | { runType: RunType; wakeReason: string; context: Record<string, unknown> }
  | undefined {
  const reactiveIntent = deriveIssueSessionReactiveIntent({
    delegatedToPatchRelay: issue.delegatedToPatchRelay,
    activeRunId: issue.activeRunId,
    prNumber: issue.prNumber,
    prState: issue.prState,
    prReviewState: issue.prReviewState,
    prCheckStatus: issue.prCheckStatus,
    latestFailureSource: issue.lastGitHubFailureSource,
  });
  if (!reactiveIntent) return undefined;

  if (reactiveIntent.runType === "ci_repair") {
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson) ?? {};
    const snapshot = parseObjectJson(issue.lastGitHubCiSnapshotJson);
    const fallbackHeadSha = typeof failureContext.failureHeadSha === "string"
      ? failureContext.failureHeadSha
      : issue.lastGitHubFailureHeadSha ?? issue.prHeadSha;
    const failureSignature = issue.lastGitHubFailureSignature
      ?? (fallbackHeadSha ? `implicit_branch_ci::${fallbackHeadSha}` : undefined);
    if (!failureSignature || issue.prState !== "open") return undefined;
    if (
      issue.lastAttemptedFailureSignature === failureSignature
      && (fallbackHeadSha === undefined || issue.lastAttemptedFailureHeadSha === fallbackHeadSha)
    ) {
      return undefined;
    }
    return {
      runType: reactiveIntent.runType,
      wakeReason: reactiveIntent.wakeReason,
      context: {
        ...failureContext,
        failureSignature,
        ...(fallbackHeadSha ? { failureHeadSha: fallbackHeadSha } : {}),
        ...(issue.lastGitHubFailureCheckName ? { checkName: issue.lastGitHubFailureCheckName } : {}),
        ...(snapshot ? { ciSnapshot: snapshot } : {}),
      },
    };
  }

  if (reactiveIntent.runType === "queue_repair") {
    const failureContext = parseObjectJson(issue.lastGitHubFailureContextJson) ?? {};
    const incidentContext = parseObjectJson(issue.lastQueueIncidentJson) ?? {};
    const fallbackHeadSha = typeof failureContext.failureHeadSha === "string"
      ? failureContext.failureHeadSha
      : undefined;
    if (!hasUnattemptedFailureSignature(issue, fallbackHeadSha)) return undefined;
    return {
      runType: reactiveIntent.runType,
      wakeReason: reactiveIntent.wakeReason,
      context: {
        ...incidentContext,
        ...failureContext,
      },
    };
  }

  return undefined;
}

export class WorkflowWakeResolver {
  constructor(
    private readonly issues: IssueStore,
    private readonly issueSessions: IssueSessionStore,
  ) {}

  peekIssueWake(projectId: string, linearIssueId: string): WorkflowWake | undefined {
    const explicitWake = this.issueSessions.peekIssueSessionWake(projectId, linearIssueId);
    if (explicitWake) return explicitWake;

    const issue = this.issues.getIssue(projectId, linearIssueId);
    if (!issue) return undefined;
    const implicitWake = deriveImplicitReactiveWake(issue);
    if (!implicitWake) return undefined;
    return {
      eventIds: [],
      runType: implicitWake.runType,
      context: implicitWake.context,
      wakeReason: implicitWake.wakeReason,
      resumeThread: false,
    };
  }

  hasPendingWake(projectId: string, linearIssueId: string): boolean {
    return this.peekIssueWake(projectId, linearIssueId) !== undefined;
  }
}
