import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { summarizeCurrentThread } from "./stage-reporting.ts";
import type { StageReport, StageRunRecord, TrackedIssueRecord } from "./types.ts";
import { safeJsonParse } from "./utils.ts";

interface StageStatusProvider {
  getActiveStageStatus(issueKey: string): Promise<{
    issue: TrackedIssueRecord;
    stageRun: StageRunRecord;
    liveThread?: ReturnType<typeof summarizeCurrentThread>;
  } | undefined>;
}

// Adapter interface: anything that quacks like a db for query purposes
interface QueryStore {
  getTrackedIssueByKey(issueKey: string): TrackedIssueRecord | undefined;
  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined;
  getIssueOverview(issueKey: string): {
    issue: TrackedIssueRecord;
    workspace?: any;
    activeStageRun?: StageRunRecord;
  } | undefined;
  getStageRun(id: number): StageRunRecord | undefined;
  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[];
  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined;
  listThreadEvents(runId: number): Array<{
    id: number;
    stageRunId: number;
    threadId: string;
    turnId?: string;
    method: string;
    eventJson: string;
    createdAt: string;
  }>;
}

export class IssueQueryService {
  private readonly store: QueryStore;

  constructor(
    store: QueryStore | { issueWorkflows: any; stageEvents: any },
    private readonly codex: CodexAppServerClient,
    private readonly stageFinalizer: StageStatusProvider,
  ) {
    // Support both old port-based and new direct interfaces
    if ("getTrackedIssueByKey" in store) {
      this.store = store as QueryStore;
    } else {
      const s = store as { issueWorkflows: any; stageEvents: any };
      this.store = {
        getTrackedIssueByKey: (k: string) => s.issueWorkflows.getTrackedIssueByKey(k),
        getTrackedIssue: (p: string, i: string) => s.issueWorkflows.getTrackedIssue(p, i),
        getIssueOverview: (k: string) => s.issueWorkflows.getIssueOverview(k),
        getStageRun: (id: number) => s.issueWorkflows.getStageRun(id),
        listStageRunsForIssue: (p: string, i: string) => s.issueWorkflows.listStageRunsForIssue(p, i),
        getLatestStageRunForIssue: (p: string, i: string) => s.issueWorkflows.getLatestStageRunForIssue(p, i),
        listThreadEvents: (id: number) => s.stageEvents.listThreadEvents(id),
      };
    }
  }

  async getIssueOverview(issueKey: string) {
    const result = this.store.getIssueOverview(issueKey);
    if (!result) return undefined;

    const activeStatus = await this.stageFinalizer.getActiveStageStatus(issueKey);
    const activeStageRun = activeStatus?.stageRun ?? result.activeStageRun;
    const latestStageRun = this.store.getLatestStageRunForIssue(result.issue.projectId, result.issue.linearIssueId);
    let liveThread;
    if (activeStatus?.liveThread) {
      liveThread = activeStatus.liveThread;
    } else if (activeStageRun?.threadId) {
      liveThread = await this.codex.readThread(activeStageRun.threadId, true).then(summarizeCurrentThread).catch(() => undefined);
    }

    return {
      ...result,
      ...(activeStageRun ? { activeStageRun } : {}),
      ...(latestStageRun ? { latestStageRun } : {}),
      ...(liveThread ? { liveThread } : {}),
    };
  }

  async getIssueReport(issueKey: string) {
    const issue = this.store.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    return {
      issue,
      stages: this.store.listStageRunsForIssue(issue.projectId, issue.linearIssueId).map((stageRun) => ({
        stageRun,
        ...(stageRun.reportJson ? { report: JSON.parse(stageRun.reportJson) as StageReport } : {}),
      })),
    };
  }

  async getStageEvents(issueKey: string, stageRunId: number) {
    const issue = this.store.getTrackedIssueByKey(issueKey);
    if (!issue) return undefined;

    const stageRun = this.store.getStageRun(stageRunId);
    if (!stageRun || stageRun.projectId !== issue.projectId || stageRun.linearIssueId !== issue.linearIssueId) return undefined;

    return {
      issue,
      stageRun,
      events: this.store.listThreadEvents(stageRunId).map((event) => ({
        ...event,
        parsedEvent: safeJsonParse<Record<string, unknown>>(event.eventJson),
      })),
    };
  }

  async getActiveStageStatus(issueKey: string) {
    return await this.stageFinalizer.getActiveStageStatus(issueKey);
  }

  async getPublicAgentSessionStatus(issueKey: string) {
    const overview = await this.getIssueOverview(issueKey);
    if (!overview) return undefined;

    const report = await this.getIssueReport(issueKey);
    return {
      issue: overview.issue,
      ...(overview.activeStageRun ? { activeStageRun: overview.activeStageRun } : {}),
      ...(overview.latestStageRun ? { latestStageRun: overview.latestStageRun } : {}),
      ...(overview.liveThread ? { liveThread: overview.liveThread } : {}),
      stages: report?.stages ?? [],
      generatedAt: new Date().toISOString(),
    };
  }
}
