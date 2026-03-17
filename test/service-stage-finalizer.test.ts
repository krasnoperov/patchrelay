import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { ServiceStageFinalizer } from "../src/service-stage-finalizer.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  LinearAgentActivityContent,
  LinearClient,
  LinearIssueSnapshot,
  IssueControlRecord,
  ObligationRecord,
  PipelineRunRecord,
  RunLeaseRecord,
  StageRunRecord,
  TrackedIssueRecord,
  WorkspaceOwnershipRecord,
  WorkspaceRecord,
} from "../src/types.ts";

const WORKFLOW_STATES = [
  { id: "start", name: "Start" },
  { id: "implementing", name: "Implementing" },
  { id: "human-needed", name: "Human Needed" },
];

class FakeLinearClient implements LinearClient {
  readonly issues = new Map<string, LinearIssueSnapshot>();
  readonly stateTransitions: Array<{ issueId: string; stateName: string }> = [];
  readonly comments: Array<{ issueId: string; commentId?: string; body: string }> = [];
  readonly agentActivities: Array<{ agentSessionId: string; content: LinearAgentActivityContent; ephemeral?: boolean }> = [];
  readonly agentSessionUpdates: Array<{
    agentSessionId: string;
    externalUrls?: Array<{ label: string; url: string }>;
    plan?: Array<{ label: string; status: "pending" | "in_progress" | "completed" }>;
  }> = [];
  failNextAgentSessionUpdate = false;
  failNextAgentActivity = false;

  async getIssue(issueId: string): Promise<LinearIssueSnapshot> {
    const issue = this.issues.get(issueId);
    assert.ok(issue);
    return issue;
  }

  async setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(issueId);
    const nextIssue = {
      ...issue,
      stateId: stateName.toLowerCase().replaceAll(" ", "-"),
      stateName,
    };
    this.issues.set(issueId, nextIssue);
    this.stateTransitions.push({ issueId, stateName });
    return nextIssue;
  }

  async upsertIssueComment(params: { issueId: string; commentId?: string; body: string }): Promise<{ id: string; body: string }> {
    this.comments.push(params);
    return {
      id: params.commentId ?? `comment-${this.comments.length}`,
      body: params.body,
    };
  }

  async createAgentActivity(params: {
    agentSessionId: string;
    content: LinearAgentActivityContent;
    ephemeral?: boolean;
  }): Promise<{ id: string }> {
    if (this.failNextAgentActivity) {
      this.failNextAgentActivity = false;
      throw new Error("agent activity failed");
    }
    this.agentActivities.push(params);
    return { id: `activity-${this.agentActivities.length}` };
  }

  async updateAgentSession(params: {
    agentSessionId: string;
    externalUrls?: Array<{ label: string; url: string }>;
    plan?: Array<{ label: string; status: "pending" | "in_progress" | "completed" }>;
  }): Promise<{ id: string }> {
    if (this.failNextAgentSessionUpdate) {
      this.failNextAgentSessionUpdate = false;
      throw new Error("agent session update failed");
    }
    this.agentSessionUpdates.push(params);
    return { id: params.agentSessionId };
  }

  async updateIssueLabels(params: { issueId: string }): Promise<LinearIssueSnapshot> {
    return await this.getIssue(params.issueId);
  }

  async getActorProfile() {
    return {};
  }
}

class FakeCodexClient {
  readonly steerCalls: Array<{ threadId: string; turnId: string; input: string }> = [];
  readonly resumedThreads: Array<{ threadId: string; cwd?: string }> = [];
  readonly startedTurns: Array<{ threadId: string; cwd: string; input: string }> = [];
  readonly threads = new Map<string, CodexThreadSummary>();
  readonly resumableThreads = new Map<string, CodexThreadSummary>();
  steerError?: Error;

  async readThread(threadId: string): Promise<CodexThreadSummary> {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error("thread not found");
    }
    return thread;
  }

  async resumeThread(threadId: string, cwd?: string): Promise<CodexThreadSummary> {
    this.resumedThreads.push({ threadId, cwd });
    const thread = this.resumableThreads.get(threadId) ?? this.threads.get(threadId);
    if (!thread) {
      throw new Error("thread not found");
    }
    this.threads.set(threadId, thread);
    return thread;
  }

  async startTurn(params: { threadId: string; cwd: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }> {
    this.startedTurns.push(params);
    const thread = this.threads.get(params.threadId);
    assert.ok(thread);
    const turnId = `turn-recovery-${this.startedTurns.length}`;
    thread.status = "active";
    thread.turns.push({
      id: turnId,
      status: "inProgress",
      items: [],
    });
    return { threadId: params.threadId, turnId, status: "inProgress" };
  }

  async steerTurn(params: { threadId: string; turnId: string; input: string }): Promise<void> {
    if (this.steerError) {
      throw this.steerError;
    }
    this.steerCalls.push(params);
  }
}

class FakeIssueWorkflowStore {
  readonly issues = new Map<string, TrackedIssueRecord>();
  readonly stageRuns = new Map<number, StageRunRecord>();
  readonly pipelines = new Map<number, PipelineRunRecord>();
  readonly workspaces = new Map<number, WorkspaceRecord>();
  readonly finishedStageRuns: Array<{
    stageRunId: number;
    status: StageRunRecord["status"];
    threadId: string;
    turnId?: string;
    summaryJson?: string;
    reportJson?: string;
  }> = [];
  readonly lifecycleStatuses: Array<{ projectId: string; issueId: string; status: TrackedIssueRecord["lifecycleStatus"] }> = [];
  readonly statusComments: Array<{ projectId: string; issueId: string; commentId?: string }> = [];
  readonly pipelineStatuses: Array<{ pipelineRunId: number; status: PipelineRunRecord["status"] }> = [];
  readonly completedPipelines: number[] = [];
  readonly threadUpdates: Array<{ stageRunId: number; threadId: string; parentThreadId?: string; turnId?: string }> = [];

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    return this.issues.get(issueKey(projectId, linearIssueId));
  }

  getTrackedIssueByKey(issueKeyValue: string): TrackedIssueRecord | undefined {
    return [...this.issues.values()].find((issue) => issue.issueKey === issueKeyValue);
  }

  getStageRun(stageRunId: number): StageRunRecord | undefined {
    return this.stageRuns.get(stageRunId);
  }

  getStageRunByThreadId(threadId: string): StageRunRecord | undefined {
    return [...this.stageRuns.values()].find((stageRun) => stageRun.threadId === threadId);
  }

  listActiveStageRuns(): StageRunRecord[] {
    return [...this.stageRuns.values()].filter((stageRun) => stageRun.status === "running");
  }

  listStageRunsForIssue(projectId: string, linearIssueId: string): StageRunRecord[] {
    return [...this.stageRuns.values()].filter((stageRun) => stageRun.projectId === projectId && stageRun.linearIssueId === linearIssueId);
  }

  getLatestStageRunForIssue(projectId: string, linearIssueId: string): StageRunRecord | undefined {
    return this.listStageRunsForIssue(projectId, linearIssueId).at(-1);
  }

  updateStageRunThread(params: { stageRunId: number; threadId: string; parentThreadId?: string; turnId?: string }): void {
    const stageRun = this.stageRuns.get(params.stageRunId);
    assert.ok(stageRun);
    stageRun.threadId = params.threadId;
    if (params.parentThreadId !== undefined) {
      stageRun.parentThreadId = params.parentThreadId;
    }
    if (params.turnId !== undefined) {
      stageRun.turnId = params.turnId;
    }
    this.threadUpdates.push(params);
  }

  finishStageRun(params: {
    stageRunId: number;
    status: StageRunRecord["status"];
    threadId: string;
    turnId?: string;
    summaryJson?: string;
    reportJson?: string;
  }): void {
    const stageRun = this.stageRuns.get(params.stageRunId);
    assert.ok(stageRun);
    stageRun.status = params.status;
    stageRun.threadId = params.threadId;
    stageRun.turnId = params.turnId;
    this.finishedStageRuns.push(params);
  }

  upsertTrackedIssue(params: {
    projectId: string;
    linearIssueId: string;
    currentLinearState?: string;
    statusCommentId?: string | null;
    lifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
  }): TrackedIssueRecord {
    const existing = this.getTrackedIssue(params.projectId, params.linearIssueId);
    assert.ok(existing);
    if (existing.lifecycleStatus !== params.lifecycleStatus) {
      this.lifecycleStatuses.push({
        projectId: params.projectId,
        issueId: params.linearIssueId,
        status: params.lifecycleStatus,
      });
    }
    const nextIssue = {
      ...existing,
      ...(params.currentLinearState ? { currentLinearState: params.currentLinearState } : {}),
      ...(params.statusCommentId !== undefined ? { statusCommentId: params.statusCommentId ?? undefined } : {}),
      lifecycleStatus: params.lifecycleStatus,
    };
    this.issues.set(issueKey(params.projectId, params.linearIssueId), nextIssue);
    return nextIssue;
  }

  setIssueLifecycleStatus(projectId: string, linearIssueId: string, status: TrackedIssueRecord["lifecycleStatus"]): void {
    const issue = this.getTrackedIssue(projectId, linearIssueId);
    assert.ok(issue);
    issue.lifecycleStatus = status;
    this.lifecycleStatuses.push({ projectId, issueId: linearIssueId, status });
  }

  setIssueStatusComment(projectId: string, linearIssueId: string, commentId?: string): void {
    const issue = this.getTrackedIssue(projectId, linearIssueId);
    assert.ok(issue);
    issue.statusCommentId = commentId;
    this.statusComments.push({ projectId, issueId: linearIssueId, commentId });
  }

  getPipelineRun(pipelineRunId: number): PipelineRunRecord | undefined {
    return this.pipelines.get(pipelineRunId);
  }

  setPipelineStatus(pipelineRunId: number, status: PipelineRunRecord["status"]): void {
    const pipeline = this.getPipelineRun(pipelineRunId);
    assert.ok(pipeline);
    pipeline.status = status;
    this.pipelineStatuses.push({ pipelineRunId, status });
  }

  markPipelineCompleted(pipelineRunId: number): void {
    const pipeline = this.getPipelineRun(pipelineRunId);
    assert.ok(pipeline);
    pipeline.status = "completed";
    this.completedPipelines.push(pipelineRunId);
  }

  getWorkspace(workspaceId: number): WorkspaceRecord | undefined {
    return this.workspaces.get(workspaceId);
  }
}

class FakeStageEventStore {
  readonly savedEvents: Array<{ stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }> = [];
  readonly pendingInputs: Array<{ id: number; stageRunId: number; body: string; source: string; threadId?: string; turnId?: string }> = [];
  readonly deliveredInputs: number[] = [];

  listThreadEvents(): Array<{ method: string }> {
    return this.savedEvents.map((event) => ({ method: event.method }));
  }

  saveThreadEvent(params: { stageRunId: number; threadId: string; turnId?: string; method: string; eventJson: string }): number {
    this.savedEvents.push(params);
    return this.savedEvents.length;
  }

  enqueueTurnInput(params: { stageRunId: number; threadId?: string; turnId?: string; source: string; body: string }): number {
    const id = this.pendingInputs.length + 1;
    this.pendingInputs.push({ id, ...params });
    return id;
  }

  listPendingTurnInputs(stageRunId: number) {
    return this.pendingInputs.filter((input) => input.stageRunId === stageRunId && !this.deliveredInputs.includes(input.id));
  }

  setPendingTurnInputRouting(id: number, threadId: string, turnId: string): void {
    const input = this.pendingInputs.find((entry) => entry.id === id);
    assert.ok(input);
    input.threadId = threadId;
    input.turnId = turnId;
  }

  markTurnInputDelivered(id: number): void {
    this.deliveredInputs.push(id);
  }
}

class FakeLedgerStore {
  readonly issueControls = new Map<string, IssueControlRecord>();
  readonly runLeases = new Map<number, RunLeaseRecord>();
  readonly obligations = new Map<number, ObligationRecord>();
  readonly workspaceOwnership = new Map<number, WorkspaceOwnershipRecord>();
  private nextRunLeaseId = 90;

  getIssueControl(projectId: string, linearIssueId: string): IssueControlRecord | undefined {
    return this.issueControls.get(issueKey(projectId, linearIssueId));
  }

  upsertIssueControl(params: {
    projectId: string;
    linearIssueId: string;
    desiredStage?: StageRunRecord["stage"] | null;
    desiredReceiptId?: number | null;
    activeWorkspaceOwnershipId?: number | null;
    activeRunLeaseId?: number | null;
    serviceOwnedCommentId?: string | null;
    activeAgentSessionId?: string | null;
    lifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
  }): IssueControlRecord {
    const existing = this.getIssueControl(params.projectId, params.linearIssueId);
    const nextIssueControl: IssueControlRecord = {
      id: existing?.id ?? 1,
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.desiredStage !== undefined
        ? (params.desiredStage ? { desiredStage: params.desiredStage } : {})
        : existing?.desiredStage
          ? { desiredStage: existing.desiredStage }
          : {}),
      ...(params.desiredReceiptId !== undefined
        ? (params.desiredReceiptId !== null ? { desiredReceiptId: params.desiredReceiptId } : {})
        : existing?.desiredReceiptId !== undefined
          ? { desiredReceiptId: existing.desiredReceiptId }
          : {}),
      ...(params.activeWorkspaceOwnershipId !== undefined
        ? (params.activeWorkspaceOwnershipId !== null ? { activeWorkspaceOwnershipId: params.activeWorkspaceOwnershipId } : {})
        : existing?.activeWorkspaceOwnershipId !== undefined
          ? { activeWorkspaceOwnershipId: existing.activeWorkspaceOwnershipId }
          : {}),
      ...(params.activeRunLeaseId !== undefined
        ? (params.activeRunLeaseId !== null ? { activeRunLeaseId: params.activeRunLeaseId } : {})
        : existing?.activeRunLeaseId !== undefined
          ? { activeRunLeaseId: existing.activeRunLeaseId }
          : {}),
      ...(params.serviceOwnedCommentId !== undefined
        ? (params.serviceOwnedCommentId ? { serviceOwnedCommentId: params.serviceOwnedCommentId } : {})
        : existing?.serviceOwnedCommentId
          ? { serviceOwnedCommentId: existing.serviceOwnedCommentId }
          : {}),
      ...(params.activeAgentSessionId !== undefined
        ? (params.activeAgentSessionId ? { activeAgentSessionId: params.activeAgentSessionId } : {})
        : existing?.activeAgentSessionId
          ? { activeAgentSessionId: existing.activeAgentSessionId }
          : {}),
      lifecycleStatus: params.lifecycleStatus,
      updatedAt: "2026-03-12T00:00:00.000Z",
    };
    this.issueControls.set(issueKey(params.projectId, params.linearIssueId), nextIssueControl);
    return nextIssueControl;
  }

  getRunLease(id: number): RunLeaseRecord | undefined {
    return this.runLeases.get(id);
  }

  listActiveRunLeases(): RunLeaseRecord[] {
    return [...this.runLeases.values()].filter((runLease) => runLease.status === "running");
  }

  createRunLease(params: {
    issueControlId: number;
    projectId: string;
    linearIssueId: string;
    workspaceOwnershipId: number;
    stage: StageRunRecord["stage"];
    triggerReceiptId?: number | null;
    status?: Extract<RunLeaseRecord["status"], "queued" | "running" | "paused">;
  }): RunLeaseRecord {
    const runLease: RunLeaseRecord = {
      id: this.nextRunLeaseId++,
      issueControlId: params.issueControlId,
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      workspaceOwnershipId: params.workspaceOwnershipId,
      stage: params.stage,
      status: params.status ?? "queued",
      ...(params.triggerReceiptId ? { triggerReceiptId: params.triggerReceiptId } : {}),
      startedAt: "2026-03-12T00:00:00.000Z",
    };
    this.runLeases.set(runLease.id, runLease);
    return runLease;
  }

  updateRunLeaseThread(params: { runLeaseId: number; threadId?: string | null; turnId?: string | null; parentThreadId?: string | null }): void {
    const runLease = this.runLeases.get(params.runLeaseId);
    assert.ok(runLease);
    if (params.threadId) {
      runLease.threadId = params.threadId;
    }
    if (params.turnId) {
      runLease.turnId = params.turnId;
    }
    if (params.parentThreadId) {
      runLease.parentThreadId = params.parentThreadId;
    }
  }

  finishRunLease(params: {
    runLeaseId: number;
    status: "paused" | "completed" | "failed" | "released";
    threadId?: string | null;
    turnId?: string | null;
    failureReason?: string | null;
  }): void {
    const runLease = this.runLeases.get(params.runLeaseId);
    assert.ok(runLease);
    runLease.status = params.status;
    if (params.threadId) {
      runLease.threadId = params.threadId;
    }
    if (params.turnId) {
      runLease.turnId = params.turnId;
    }
    if (params.failureReason) {
      runLease.failureReason = params.failureReason;
    }
  }

  getWorkspaceOwnership(id: number): WorkspaceOwnershipRecord | undefined {
    return this.workspaceOwnership.get(id);
  }

  upsertWorkspaceOwnership(params: {
    projectId: string;
    linearIssueId: string;
    branchName: string;
    worktreePath: string;
    status: WorkspaceOwnershipRecord["status"];
    currentRunLeaseId?: number | null;
  }): WorkspaceOwnershipRecord {
    const existing = [...this.workspaceOwnership.values()].find(
      (workspace) => workspace.projectId === params.projectId && workspace.linearIssueId === params.linearIssueId,
    );
    const nextWorkspace: WorkspaceOwnershipRecord = {
      id: existing?.id ?? 40,
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      branchName: params.branchName,
      worktreePath: params.worktreePath,
      status: params.status,
      ...(params.currentRunLeaseId !== undefined
        ? (params.currentRunLeaseId !== null ? { currentRunLeaseId: params.currentRunLeaseId } : {})
        : existing?.currentRunLeaseId !== undefined
          ? { currentRunLeaseId: existing.currentRunLeaseId }
          : {}),
      createdAt: existing?.createdAt ?? "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    };
    this.workspaceOwnership.set(nextWorkspace.id, nextWorkspace);
    return nextWorkspace;
  }

  listPendingObligations(params?: { runLeaseId?: number; kind?: string; includeInProgress?: boolean }): ObligationRecord[] {
    return [...this.obligations.values()].filter((obligation) => {
      if (obligation.status === "completed" || obligation.status === "cancelled" || obligation.status === "failed") {
        return false;
      }
      if (!params?.includeInProgress && obligation.status === "in_progress") {
        return false;
      }
      if (params?.runLeaseId !== undefined && obligation.runLeaseId !== params.runLeaseId) {
        return false;
      }
      if (params?.kind && obligation.kind !== params.kind) {
        return false;
      }
      return true;
    });
  }

  claimPendingObligation(id: number, params?: { runLeaseId?: number | null; threadId?: string | null; turnId?: string | null }): boolean {
    const obligation = this.obligations.get(id);
    assert.ok(obligation);
    if (obligation.status !== "pending") {
      return false;
    }
    obligation.status = "in_progress";
    obligation.lastError = undefined;
    if (params?.runLeaseId !== undefined) {
      obligation.runLeaseId = params.runLeaseId ?? undefined;
    }
    if (params?.threadId !== undefined) {
      obligation.threadId = params.threadId ?? undefined;
    }
    if (params?.turnId !== undefined) {
      obligation.turnId = params.turnId ?? undefined;
    }
    return true;
  }

  updateObligationPayloadJson(id: number, payloadJson: string): void {
    const obligation = this.obligations.get(id);
    assert.ok(obligation);
    obligation.payloadJson = payloadJson;
  }

  updateObligationRouting(id: number, params: { threadId?: string | null; turnId?: string | null }): void {
    const obligation = this.obligations.get(id);
    assert.ok(obligation);
    if (params.threadId) {
      obligation.threadId = params.threadId;
    }
    if (params.turnId) {
      obligation.turnId = params.turnId;
    }
  }

  markObligationStatus(id: number, status: ObligationRecord["status"], lastError?: string | null): void {
    const obligation = this.obligations.get(id);
    assert.ok(obligation);
    obligation.status = status;
    if (lastError) {
      obligation.lastError = lastError;
    }
    if (status === "completed") {
      obligation.completedAt = "2026-03-12T00:00:00.000Z";
    }
  }
}

function issueKey(projectId: string, issueId: string): string {
  return `${projectId}:${issueId}`;
}

function createConfig(persistExtendedHistory: boolean): AppConfig {
  return {
    server: { bind: "127.0.0.1", port: 8787, healthPath: "/health", readinessPath: "/ready" },
    ingress: { linearWebhookPath: "/webhooks/linear", maxBodyBytes: 1024, maxTimestampSkewSeconds: 60 },
    logging: { level: "info", format: "logfmt", filePath: "/tmp/patchrelay.log" },
    database: { path: "/tmp/patchrelay.sqlite", wal: true },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "app",
      },
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
    },
    operatorApi: { enabled: false },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory,
      },
    },
    projects: [
      {
        id: "proj",
        repoPath: "/tmp/repo",
        worktreeRoot: "/tmp/worktrees",
        workflows: [
          {
            id: "development",
            whenState: "Start",
            activeState: "Implementing",
            workflowFile: "/tmp/IMPLEMENTATION_WORKFLOW.md",
            fallbackState: "Human Needed",
          },
        ],
        issueKeyPrefixes: ["APP"],
        linearTeamIds: ["APP"],
        allowLabels: [],
        triggerEvents: ["statusChanged", "commentCreated", "commentUpdated"],
        branchPrefix: "app",
      },
    ],
  };
}

function createIssue(overrides: Partial<TrackedIssueRecord> = {}): TrackedIssueRecord {
  return {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "APP-1",
    title: "Reconcile stage",
    currentLinearState: "Implementing",
    statusCommentId: "comment-1",
    activeAgentSessionId: "session-1",
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function createStageRun(overrides: Partial<StageRunRecord> = {}): StageRunRecord {
  return {
    id: 10,
    pipelineRunId: 20,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceId: 30,
    stage: "development",
    status: "running",
    triggerWebhookId: "delivery-1",
    workflowFile: "/tmp/IMPLEMENTATION_WORKFLOW.md",
    promptText: "Implement it",
    threadId: "thread-1",
    turnId: "turn-1",
    startedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function createPipeline(overrides: Partial<PipelineRunRecord> = {}): PipelineRunRecord {
  return {
    id: 20,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceId: 30,
    status: "active",
    currentStage: "development",
    startedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function createWorkspace(overrides: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: 30,
    projectId: "proj",
    linearIssueId: "issue-1",
    branchName: "app/APP-1",
    worktreePath: "/tmp/worktrees/APP-1",
    status: "active",
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
    ...overrides,
  };
}

function createThread(status: "completed" | "inProgress" | "interrupted"): CodexThreadSummary {
  return createThreadWithId("thread-1", status);
}

function createThreadWithId(id: string, status: "completed" | "inProgress" | "interrupted"): CodexThreadSummary {
  return {
    id,
    preview: "PatchRelay stage",
    cwd: "/tmp/worktrees/APP-1",
    status: status === "completed" ? "idle" : status === "interrupted" ? "idle" : "running",
    turns: [
      {
        id: "turn-1",
        status,
        items: [],
      },
    ],
  };
}

function createHarness(options?: {
  persistExtendedHistory?: boolean;
  issueStateName?: string;
  stageRun?: Partial<StageRunRecord>;
  withLedger?: boolean;
  withoutActiveLease?: boolean;
  pendingObligationBody?: string;
  issueControlLifecycleStatus?: TrackedIssueRecord["lifecycleStatus"];
}) {
  const config = createConfig(options?.persistExtendedHistory ?? true);
  const store = new FakeIssueWorkflowStore();
  const stageEvents = new FakeStageEventStore();
  const ledger = new FakeLedgerStore();
  const codex = new FakeCodexClient();
  const linear = new FakeLinearClient();
  const issue = createIssue();
  const stageRun = createStageRun(options?.stageRun);
  const pipeline = createPipeline();
  const workspace = createWorkspace();
  store.issues.set(issueKey(issue.projectId, issue.linearIssueId), issue);
  store.stageRuns.set(stageRun.id, stageRun);
  store.pipelines.set(pipeline.id, pipeline);
  store.workspaces.set(workspace.id, workspace);
  if (options?.withLedger) {
    const workspaceOwnership = ledger.upsertWorkspaceOwnership({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      branchName: workspace.branchName,
      worktreePath: workspace.worktreePath,
      status: "active",
    });
    const issueControl = ledger.upsertIssueControl({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeWorkspaceOwnershipId: workspaceOwnership.id,
      ...(options.withoutActiveLease ? {} : { activeRunLeaseId: 90 }),
      serviceOwnedCommentId: issue.statusCommentId ?? null,
      activeAgentSessionId: issue.activeAgentSessionId ?? null,
      lifecycleStatus: options.issueControlLifecycleStatus ?? issue.lifecycleStatus,
    });
    if (!options.withoutActiveLease) {
      ledger.runLeases.set(90, {
        id: 90,
        issueControlId: issueControl.id,
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        workspaceOwnershipId: workspaceOwnership.id,
        stage: stageRun.stage,
        status: "running",
        threadId: stageRun.threadId,
        turnId: stageRun.turnId,
        startedAt: stageRun.startedAt,
      });
    }
    if (options.pendingObligationBody) {
      stageEvents.enqueueTurnInput({
        stageRunId: stageRun.id,
        threadId: stageRun.threadId,
        turnId: stageRun.turnId,
        source: "linear-comment:1",
        body: options.pendingObligationBody,
      });
      ledger.obligations.set(1, {
        id: 1,
        projectId: issue.projectId,
        linearIssueId: issue.linearIssueId,
        kind: "deliver_turn_input",
        status: "pending",
        source: "linear-comment:1",
        payloadJson: JSON.stringify({
          queuedInputId: 1,
          stageRunId: stageRun.id,
          body: options.pendingObligationBody,
        }),
        runLeaseId: 90,
        createdAt: "2026-03-12T00:00:00.000Z",
        updatedAt: "2026-03-12T00:00:00.000Z",
      });
    }
  }
  linear.issues.set(issue.linearIssueId, {
    id: issue.linearIssueId,
    identifier: issue.issueKey,
    title: issue.title,
    stateId: "implementing",
    stateName: options?.issueStateName ?? "Implementing",
    workflowStates: WORKFLOW_STATES,
    labelIds: [],
    labels: [],
    teamLabels: [],
  });

  const finalizer = new ServiceStageFinalizer(
    config,
    {
      workflowCoordinator: store,
      issueWorkflows: store,
      stageEvents,
      issueControl: ledger,
      runLeases: ledger,
      obligations: ledger,
      workspaceOwnership: ledger,
    },
    codex as never,
    {
      async forProject(projectId: string) {
        return projectId === "proj" ? linear : undefined;
      },
    },
    () => undefined,
    pino({ enabled: false }),
  );

  return { store, stageEvents, ledger, codex, linear, finalizer, issue, stageRun };
}

test("reconciliation fails an active stage when the persisted thread is missing", async () => {
  const { store, linear, finalizer, stageRun } = createHarness({ withLedger: true });

  await finalizer.reconcileActiveStageRuns();

  assert.equal(store.getStageRun(stageRun.id)?.status, "failed");
  assert.deepEqual(linear.stateTransitions, [{ issueId: "issue-1", stateName: "Human Needed" }]);
  assert.equal(linear.comments.length, 0);
  assert.match(String(linear.agentActivities[0]?.content.body ?? ""), /thread was not found during reconciliation/);
  assert.deepEqual(store.lifecycleStatuses.at(-1), {
    projectId: "proj",
    issueId: "issue-1",
    status: "failed",
  });
});

test("reconciliation falls back to a failure comment when the stored agent session cannot be updated", async () => {
  const { linear, finalizer } = createHarness({ withLedger: true });

  linear.failNextAgentSessionUpdate = true;
  linear.failNextAgentActivity = true;

  await finalizer.reconcileActiveStageRuns();

  assert.equal(linear.comments.length, 1);
  assert.match(linear.comments[0]?.body ?? "", /marked the development workflow as failed/i);
});

test("reconciliation leaves an active stage alone when the latest turn is still in progress", async () => {
  const { store, codex, linear, finalizer, stageRun } = createHarness();
  codex.threads.set(stageRun.threadId!, createThread("inProgress"));

  await finalizer.reconcileActiveStageRuns();

  assert.equal(store.getStageRun(stageRun.id)?.status, "running");
  assert.equal(linear.stateTransitions.length, 0);
  assert.equal(store.finishedStageRuns.length, 0);
});

test("reconciliation restarts an interrupted turn on the existing thread instead of failing back", async () => {
  const { store, codex, linear, finalizer, stageRun } = createHarness({ withLedger: true });
  codex.threads.set(stageRun.threadId!, createThread("interrupted"));

  await finalizer.reconcileActiveStageRuns();

  assert.deepEqual(codex.resumedThreads, [{ threadId: "thread-1", cwd: "/tmp/worktrees/APP-1" }]);
  assert.equal(codex.startedTurns.length, 1);
  assert.match(codex.startedTurns[0]!.input, /PatchRelay restarted while the development workflow was mid-turn/);
  assert.equal(store.getStageRun(stageRun.id)?.status, "running");
  assert.equal(store.getStageRun(stageRun.id)?.turnId, "turn-recovery-1");
  assert.equal(linear.stateTransitions.length, 0);
  assert.equal(linear.comments.length, 0);
});

test("reconciliation can recover a missing thread by resuming it from the ledger worktree", async () => {
  const { store, codex, linear, finalizer, stageRun } = createHarness({ withLedger: true });
  codex.resumableThreads.set(stageRun.threadId!, createThread("interrupted"));

  await finalizer.reconcileActiveStageRuns();

  assert.deepEqual(codex.resumedThreads, [{ threadId: "thread-1", cwd: "/tmp/worktrees/APP-1" }]);
  assert.equal(codex.startedTurns.length, 1);
  assert.equal(store.getStageRun(stageRun.id)?.status, "running");
  assert.equal(store.getStageRun(stageRun.id)?.turnId, "turn-recovery-1");
  assert.equal(linear.stateTransitions.length, 0);
});

test("reconciliation only fails back to Linear when the issue is still in the service-owned active state", async () => {
  const { store, linear, finalizer, stageRun } = createHarness({ withLedger: true, issueStateName: "Review" });

  await finalizer.reconcileActiveStageRuns();

  assert.equal(store.getStageRun(stageRun.id)?.status, "failed");
  assert.equal(linear.stateTransitions.length, 0);
  assert.equal(linear.comments.length, 0);
});

test("notification history is only persisted when extended history is enabled", async () => {
  const disabled = createHarness({ persistExtendedHistory: false });
  await disabled.finalizer.handleCodexNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turnId: "turn-1" },
  } as never);
  assert.equal(disabled.stageEvents.savedEvents.length, 0);

  const enabled = createHarness({ persistExtendedHistory: true });
  await enabled.finalizer.handleCodexNotification({
    method: "turn/started",
    params: { threadId: "thread-1", turnId: "turn-1" },
  } as never);
  assert.equal(enabled.stageEvents.savedEvents.length, 1);
  assert.equal(enabled.stageEvents.savedEvents[0]?.method, "turn/started");
});

test("ledger reconciliation replays obligations without relying on a queued-input mirror", async () => {
  const { stageEvents, ledger, codex, finalizer, stageRun } = createHarness({
    withLedger: true,
    pendingObligationBody: "Please update the handoff copy.",
  });
  codex.threads.set(stageRun.threadId!, createThread("inProgress"));

  await finalizer.reconcileActiveStageRuns();

  assert.deepEqual(codex.steerCalls, [
    {
      threadId: "thread-1",
      turnId: "turn-1",
      input: "Please update the handoff copy.",
    },
  ]);
  assert.equal(ledger.obligations.get(1)?.status, "completed");
  assert.equal(stageEvents.deliveredInputs.length, 0);
});

test("ledger reconciliation replays obligations without requiring a mirrored legacy queue row", async () => {
  const { stageEvents, ledger, codex, finalizer, stageRun } = createHarness({
    withLedger: true,
    pendingObligationBody: "Please update the deployment notes.",
  });
  codex.threads.set(stageRun.threadId!, createThread("inProgress"));
  stageEvents.deliveredInputs = [];
  stageEvents.pendingInputs = [];

  await finalizer.reconcileActiveStageRuns();

  assert.deepEqual(codex.steerCalls, [
    {
      threadId: "thread-1",
      turnId: "turn-1",
      input: "Please update the deployment notes.",
    },
  ]);
  assert.equal(ledger.obligations.get(1)?.status, "completed");
  assert.equal(stageEvents.deliveredInputs.length, 0);
});

test("ledger reconciliation uses the run lease thread snapshot instead of legacy stage-run metadata", async () => {
  const { store, ledger, codex, finalizer, stageRun } = createHarness({
    withLedger: true,
    stageRun: {
      threadId: "legacy-thread",
      turnId: "legacy-turn",
    },
  });
  const runLease = ledger.runLeases.get(90);
  assert.ok(runLease);
  runLease.threadId = "ledger-thread";
  runLease.turnId = "ledger-turn";
  codex.threads.set("ledger-thread", createThreadWithId("ledger-thread", "completed"));

  await finalizer.reconcileActiveStageRuns();

  assert.equal(store.getStageRun(stageRun.id)?.status, "completed");
  assert.equal(store.finishedStageRuns.at(-1)?.threadId, "ledger-thread");
  assert.equal(store.finishedStageRuns.at(-1)?.turnId, "turn-1");
});

test("startup reconciliation ignores legacy-only stage runs when no active run lease exists", async () => {
  const { store, ledger, codex, finalizer, stageRun } = createHarness({ withLedger: true, withoutActiveLease: true });
  codex.threads.set(stageRun.threadId!, createThread("inProgress"));

  await finalizer.reconcileActiveStageRuns();

  assert.equal(store.getStageRun(stageRun.id)?.status, "running");
  assert.equal(store.finishedStageRuns.length, 0);
  assert.equal(ledger.listActiveRunLeases().length, 0);
  assert.equal(ledger.getIssueControl("proj", "issue-1")?.activeRunLeaseId, undefined);
});

test("startup reconciliation does not resurrect a legacy running stage after the ledger already marked it completed", async () => {
  const { store, ledger, codex, finalizer, stageRun } = createHarness({
    withLedger: true,
    withoutActiveLease: true,
    issueControlLifecycleStatus: "completed",
  });
  codex.threads.set(stageRun.threadId!, createThread("inProgress"));

  await finalizer.reconcileActiveStageRuns();

  assert.equal(store.getStageRun(stageRun.id)?.status, "running");
  assert.equal(ledger.listActiveRunLeases().length, 0);
  assert.equal(ledger.getIssueControl("proj", "issue-1")?.activeRunLeaseId, undefined);
  assert.equal(ledger.getIssueControl("proj", "issue-1")?.lifecycleStatus, "completed");
});

test("active stage status prefers the active lease thread over a stale legacy activeStageRun pointer", async () => {
  const { store, codex, finalizer } = createHarness({ withLedger: true });
  const issue = store.getTrackedIssue("proj", "issue-1");
  assert.ok(issue);
  const staleStageRun = createStageRun({
    id: 99,
    threadId: "stale-thread",
    turnId: "stale-turn",
    startedAt: "2026-03-11T00:00:00.000Z",
  });
  store.stageRuns.set(staleStageRun.id, staleStageRun);
  issue.activeStageRunId = staleStageRun.id;
  codex.threads.set("thread-1", {
    ...createThread("inProgress"),
    turns: [{ id: "turn-1", status: "inProgress", items: [{ type: "agentMessage", id: "assistant-1", text: "Using the lease-backed thread." }] }],
  });

  const active = await finalizer.getActiveStageStatus("APP-1");

  assert.equal(active?.stageRun.threadId, "thread-1");
  assert.equal(active?.liveThread.threadId, "thread-1");
  assert.equal(active?.liveThread.latestAgentMessage, "Using the lease-backed thread.");
});

test("ledger reconciliation keeps obligations retryable when Codex steer fails", async () => {
  const { ledger, codex, finalizer, stageRun } = createHarness({
    withLedger: true,
    pendingObligationBody: "Please update the handoff copy.",
  });
  codex.threads.set(stageRun.threadId!, createThread("inProgress"));
  codex.steerError = new Error("codex temporarily unavailable");

  await finalizer.reconcileActiveStageRuns();

  assert.equal(ledger.obligations.get(1)?.status, "pending");
  assert.equal(ledger.obligations.get(1)?.lastError, "codex temporarily unavailable");
});

test("ledger reconciliation retries in-progress obligations against the live turn", async () => {
  const { ledger, codex, finalizer, stageRun } = createHarness({
    withLedger: true,
    pendingObligationBody: "Please update the handoff copy.",
  });
  const obligation = ledger.obligations.get(1);
  assert.ok(obligation);
  obligation.status = "in_progress";
  const runLease = ledger.runLeases.get(90);
  assert.ok(runLease);
  runLease.turnId = "turn-stale";
  codex.threads.set(stageRun.threadId!, {
    ...createThread("inProgress"),
    turns: [{ id: "turn-live", status: "inProgress", items: [] }],
  });

  await finalizer.reconcileActiveStageRuns();

  assert.deepEqual(codex.steerCalls, [
    {
      threadId: "thread-1",
      turnId: "turn-live",
      input: "Please update the handoff copy.",
    },
  ]);
  assert.equal(ledger.obligations.get(1)?.status, "completed");
  assert.equal(ledger.obligations.get(1)?.turnId, "turn-live");
});
