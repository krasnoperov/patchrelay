import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { summarizeCurrentThread } from "./stage-reporting.ts";
import type { StageReport } from "./types.ts";
import { safeJsonParse } from "./utils.ts";
import type { ServiceStageFinalizer } from "./service-stage-finalizer.ts";

export class IssueQueryService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly stageFinalizer: Pick<ServiceStageFinalizer, "getActiveStageStatus">,
  ) {}

  async getIssueOverview(issueKey: string) {
    const result = this.db.issueWorkflows.getIssueOverview(issueKey);
    if (!result) {
      return undefined;
    }

    const latestStageRun = this.db.issueWorkflows.getLatestStageRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (result.activeStageRun?.threadId) {
      liveThread = await this.codex.readThread(result.activeStageRun.threadId, true).catch(() => undefined);
    }

    return {
      ...result,
      ...(latestStageRun ? { latestStageRun } : {}),
      ...(liveThread ? { liveThread: summarizeCurrentThread(liveThread) } : {}),
    };
  }

  async getIssueReport(issueKey: string) {
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    return {
      issue,
      stages: this.db.issueWorkflows.listStageRunsForIssue(issue.projectId, issue.linearIssueId).map((stageRun) => ({
        stageRun,
        ...(stageRun.reportJson ? { report: JSON.parse(stageRun.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getStageEvents(issueKey: string, stageRunId: number) {
    const issue = this.db.issueWorkflows.getTrackedIssueByKey(issueKey);
    if (!issue) {
      return undefined;
    }

    const stageRun = this.db.issueWorkflows.getStageRun(stageRunId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) {
      return undefined;
    }

    return {
      issue,
      stageRun,
      events: this.db.stageEvents.listThreadEvents(stageRunId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getActiveStageStatus(issueKey: string) {
    return await this.stageFinalizer.getActiveStageStatus(issueKey);
  }
}
