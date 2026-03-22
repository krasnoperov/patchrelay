import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { summarizeCurrentThread } from "./run-reporting.ts";
import type { StageReport, RunRecord, TrackedIssueRecord } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

interface RunStatusProvider {
  getActiveRunStatus(issueKey: string): Promise<{
    issue: TrackedIssueRecord;
    run: RunRecord;
    liveThread?: ReturnType<typeof summarizeCurrentThread>;
  } | undefined>;
}

export class IssueQueryService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly runStatusProvider: RunStatusProvider,
  ) {}

  async getIssueOverview(issueKey: string) {
    const result = this.db.getIssueOverview(issueKey);
    if (!result) return undefined;

    const activeStatus = await this.runStatusProvider.getActiveRunStatus(issueKey);
    const activeRun = activeStatus?.run ?? result.activeRun;
    const latestRun = this.db.getLatestRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (activeStatus?.liveThread) {
      liveThread = activeStatus.liveThread;
    } else if (activeRun?.threadId) {
      liveThread = await this.codex.readThread(activeRun.threadId, true).then(summarizeCurrentThread).catch(() => undefined);
    }

    return {
      ...result,
      ...(activeRun ? { activeRun } : {}),
      ...(latestRun ? { latestRun } : {}),
      ...(liveThread ? { liveThread } : {}),
    };
  }

  async getIssueReport(issueKey: string) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    return {
      issue,
      runs: this.db.listRunsForIssue(issue.projectId, issue.linearIssueId).map((run) => ({
        run,
        ...(run.reportJson ? { report: JSON.parse(run.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getRunEvents(issueKey: string, runId: number) {
    const issue = this.db.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const run = this.db.getRun(runId);
    if (!run || run.projectId !== issue.projectId || run.linearIssueId !== issue.linearIssueId) return undefined;

    return {
      issue,
      run,
      events: this.db.listThreadEvents(runId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getActiveRunStatus(issueKey: string) {
    return await this.runStatusProvider.getActiveRunStatus(issueKey);
  }

  async getPublicAgentSessionStatus(issueKey: string) {
    const overview = await this.getIssueOverview(issueKey);
    if (!overview) return undefined;

    const report = await this.getIssueReport(issueKey);
    return {
      issue: overview.issue,
      ...(overview.activeRun ? { activeRun: overview.activeRun } : {}),
      ...(overview.latestRun ? { latestRun: overview.latestRun } : {}),
      ...(overview.liveThread ? { liveThread: overview.liveThread } : {}),
      runs: report?.runs ?? [],
      generatedAt: new Date().toISOString(),
    };
  }
}
