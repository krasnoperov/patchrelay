import { deriveIssueStatusNote } from "./status-note.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { RunRecord } from "./db-types.ts";
import type { CodexThreadSummary } from "./codex-types.ts";
import type { IssueOverviewResult, IssueOverviewRun, RunStatusProvider } from "./issue-overview-query.ts";

export async function getLegacyIssueOverview(params: {
  db: PatchRelayDatabase;
  issueKey: string;
  runStatusProvider: RunStatusProvider;
  buildRuns: (projectId: string, linearIssueId: string) => IssueOverviewRun[];
  readLiveThread: (run?: RunRecord | undefined) => Promise<CodexThreadSummary | undefined>;
}): Promise<IssueOverviewResult | undefined> {
  const { db, issueKey, runStatusProvider, buildRuns, readLiveThread } = params;
  const legacy = db.getIssueOverview(issueKey);
  if (!legacy) return undefined;

  const issueRecord = db.issues.getIssueByKey(issueKey);
  const activeStatus = await runStatusProvider.getActiveRunStatus(issueKey);
  const activeRun = activeStatus?.run ?? legacy.activeRun;
  const latestRun = db.runs.getLatestRunForIssue(legacy.issue.projectId, legacy.issue.linearIssueId);
  const latestEvent = db.issueSessions.listIssueSessionEvents(legacy.issue.projectId, legacy.issue.linearIssueId, { limit: 1 }).at(-1);
  const runs = buildRuns(legacy.issue.projectId, legacy.issue.linearIssueId);
  const runCount = runs.length;
  const liveThread = await readLiveThread(activeRun);
  const statusNote = issueRecord
    ? deriveIssueStatusNote({
        issue: issueRecord,
        latestRun,
        latestEvent,
        failureSummary: legacy.issue.latestFailureSummary,
        blockedByKeys: legacy.issue.blockedByKeys,
        waitingReason: legacy.issue.waitingReason,
      })
    : legacy.issue.statusNote;

  return {
    issue: {
      ...legacy.issue,
      ...(statusNote ? { statusNote } : {}),
    },
    ...(activeRun ? { activeRun } : {}),
    ...(latestRun ? { latestRun } : {}),
    ...(liveThread ? { liveThread } : {}),
    ...(runs.length > 0 ? { runs } : {}),
    ...(issueRecord
      ? {
          issueContext: {
            ...(issueRecord.description ? { description: issueRecord.description } : {}),
            ...(issueRecord.currentLinearState ? { currentLinearState: issueRecord.currentLinearState } : {}),
            ...(issueRecord.url ? { issueUrl: issueRecord.url } : {}),
            ...(issueRecord.worktreePath ? { worktreePath: issueRecord.worktreePath } : {}),
            ...(issueRecord.branchName ? { branchName: issueRecord.branchName } : {}),
            ...(issueRecord.prUrl ? { prUrl: issueRecord.prUrl } : {}),
            ...(issueRecord.priority != null ? { priority: issueRecord.priority } : {}),
            ...(issueRecord.estimate != null ? { estimate: issueRecord.estimate } : {}),
            ciRepairAttempts: issueRecord.ciRepairAttempts,
            queueRepairAttempts: issueRecord.queueRepairAttempts,
            reviewFixAttempts: issueRecord.reviewFixAttempts,
            ...(legacy.issue.latestFailureSource ? { latestFailureSource: legacy.issue.latestFailureSource } : {}),
            ...(legacy.issue.latestFailureHeadSha ? { latestFailureHeadSha: legacy.issue.latestFailureHeadSha } : {}),
            ...(legacy.issue.latestFailureCheckName ? { latestFailureCheckName: legacy.issue.latestFailureCheckName } : {}),
            ...(legacy.issue.latestFailureStepName ? { latestFailureStepName: legacy.issue.latestFailureStepName } : {}),
            ...(legacy.issue.latestFailureSummary ? { latestFailureSummary: legacy.issue.latestFailureSummary } : {}),
            runCount,
          },
        }
      : {}),
  };
}
