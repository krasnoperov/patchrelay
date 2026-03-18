import assert from "node:assert/strict";
import test from "node:test";
import type { Logger } from "pino";
import { StageLifecyclePublisher } from "../src/stage-lifecycle-publisher.ts";
import type {
  AppConfig,
  IssueControlRecord,
  LinearAgentActivityContent,
  LinearClient,
  LinearIssueSnapshot,
  PipelineRunRecord,
  StageRunRecord,
  TrackedIssueRecord,
  WorkspaceRecord,
} from "../src/types.ts";

const WORKFLOW_STATES = [
  { id: "start", name: "Start" },
  { id: "implementing", name: "Implementing" },
  { id: "review", name: "Review" },
  { id: "reviewing", name: "Reviewing" },
  { id: "done", name: "Done" },
];

class FakeLinearClient implements LinearClient {
  readonly issues = new Map<string, LinearIssueSnapshot>();
  readonly stateTransitions: Array<{ issueId: string; stateName: string }> = [];
  readonly labelUpdates: Array<{ issueId: string; addNames: string[]; removeNames: string[] }> = [];
  readonly comments: Array<{ issueId: string; commentId?: string; body: string }> = [];
  readonly agentActivities: Array<{ agentSessionId: string; content: LinearAgentActivityContent; ephemeral?: boolean }> = [];
  readonly agentSessionUpdates: Array<{
    agentSessionId: string;
    externalUrls?: Array<{ label: string; url: string }>;
    plan?: Array<{ content: string; status: "pending" | "inProgress" | "completed" | "canceled" }>;
  }> = [];
  failNextCommentUpsert = false;
  failNextAgentActivity = false;
  failNextAgentSessionUpdate = false;
  failNextGetIssue = false;

  async getIssue(issueId: string): Promise<LinearIssueSnapshot> {
    if (this.failNextGetIssue) {
      this.failNextGetIssue = false;
      throw new Error("issue read failed");
    }
    const issue = this.issues.get(issueId);
    assert.ok(issue);
    return issue;
  }

  async setIssueState(issueId: string, stateName: string): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(issueId);
    const nextIssue = { ...issue, stateName };
    this.issues.set(issueId, nextIssue);
    this.stateTransitions.push({ issueId, stateName });
    return nextIssue;
  }

  async upsertIssueComment(params: { issueId: string; commentId?: string; body: string }) {
    if (this.failNextCommentUpsert) {
      this.failNextCommentUpsert = false;
      throw new Error("comment write failed");
    }
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
  }) {
    if (this.failNextAgentActivity) {
      this.failNextAgentActivity = false;
      throw new Error("agent activity write failed");
    }
    this.agentActivities.push(params);
    return { id: `activity-${this.agentActivities.length}` };
  }

  async updateAgentSession(params: {
    agentSessionId: string;
    externalUrls?: Array<{ label: string; url: string }>;
    plan?: Array<{ content: string; status: "pending" | "inProgress" | "completed" | "canceled" }>;
  }) {
    if (this.failNextAgentSessionUpdate) {
      this.failNextAgentSessionUpdate = false;
      throw new Error("agent session update failed");
    }
    this.agentSessionUpdates.push(params);
    return { id: params.agentSessionId };
  }

  async updateIssueLabels(params: { issueId: string; addNames?: string[]; removeNames?: string[] }): Promise<LinearIssueSnapshot> {
    const issue = await this.getIssue(params.issueId);
    this.labelUpdates.push({
      issueId: params.issueId,
      addNames: params.addNames ?? [],
      removeNames: params.removeNames ?? [],
    });
    return issue;
  }

  async getActorProfile() {
    return {};
  }
}

class FakeIssueWorkflowStore {
  readonly issues = new Map<string, TrackedIssueRecord>();
  readonly issueControls = new Map<string, IssueControlRecord>();
  readonly stageRuns = new Map<number, StageRunRecord>();
  readonly workspaces = new Map<number, WorkspaceRecord>();
  readonly pipelines = new Map<number, PipelineRunRecord>();
  readonly lifecycleUpdates: Array<{ projectId: string; issueId: string; status: TrackedIssueRecord["lifecycleStatus"] }> = [];
  readonly statusCommentUpdates: Array<{ projectId: string; issueId: string; commentId?: string }> = [];

  upsertIssueControl(params: {
    projectId: string;
    linearIssueId: string;
    serviceOwnedCommentId?: string;
    activeAgentSessionId?: string;
    lifecycleStatus: IssueControlRecord["lifecycleStatus"];
  }): IssueControlRecord {
    const key = issueKey(params.projectId, params.linearIssueId);
    const existing = this.issueControls.get(key);
    const nextIssueControl: IssueControlRecord = {
      id: existing?.id ?? this.issueControls.size + 1,
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      serviceOwnedCommentId: params.serviceOwnedCommentId ?? existing?.serviceOwnedCommentId,
      activeAgentSessionId: params.activeAgentSessionId ?? existing?.activeAgentSessionId,
      lifecycleStatus: params.lifecycleStatus,
      createdAt: existing?.createdAt ?? "2026-03-11T10:00:00.000Z",
      updatedAt: "2026-03-11T10:05:00.000Z",
      desiredStage: existing?.desiredStage,
      desiredReceiptId: existing?.desiredReceiptId,
      activeWorkspaceOwnershipId: existing?.activeWorkspaceOwnershipId,
      activeRunLeaseId: existing?.activeRunLeaseId,
    };
    this.issueControls.set(key, nextIssueControl);
    return nextIssueControl;
  }

  upsertTrackedIssue(params: {
    projectId: string;
    linearIssueId: string;
    currentLinearState?: string;
    statusCommentId?: string | null;
    lifecycleStatus: TrackedIssueRecord["lifecycleStatus"];
  }): TrackedIssueRecord {
    const existing = this.getTrackedIssue(params.projectId, params.linearIssueId);
    const nextIssue: TrackedIssueRecord = {
      ...(existing ?? createIssueRecord()),
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      ...(params.currentLinearState ? { currentLinearState: params.currentLinearState } : {}),
      ...(params.statusCommentId !== undefined ? { statusCommentId: params.statusCommentId ?? undefined } : {}),
      lifecycleStatus: params.lifecycleStatus,
    };
    this.issues.set(issueKey(params.projectId, params.linearIssueId), nextIssue);
    return nextIssue;
  }

  getTrackedIssue(projectId: string, linearIssueId: string): TrackedIssueRecord | undefined {
    return this.issues.get(issueKey(projectId, linearIssueId));
  }

  getStageRun(stageRunId: number): StageRunRecord | undefined {
    return this.stageRuns.get(stageRunId);
  }

  getWorkspace(workspaceId: number): WorkspaceRecord | undefined {
    return this.workspaces.get(workspaceId);
  }

  setIssueStatusComment(projectId: string, linearIssueId: string, commentId?: string): void {
    const issue = this.getTrackedIssue(projectId, linearIssueId);
    assert.ok(issue);
    issue.statusCommentId = commentId;
    this.statusCommentUpdates.push({ projectId, issueId: linearIssueId, commentId });
  }

  getPipelineRun(pipelineRunId: number): PipelineRunRecord | undefined {
    return this.pipelines.get(pipelineRunId);
  }

  setIssueLifecycleStatus(projectId: string, linearIssueId: string, status: TrackedIssueRecord["lifecycleStatus"]): void {
    const issue = this.getTrackedIssue(projectId, linearIssueId);
    assert.ok(issue);
    issue.lifecycleStatus = status;
    this.lifecycleUpdates.push({ projectId, issueId: linearIssueId, status });
  }
}

function createCaptureLogger() {
  const warnings: Array<{ bindings: Record<string, unknown>; message: string }> = [];
  const logger = {
    fatal() {},
    error() {},
    warn(bindings: Record<string, unknown>, message: string) {
      warnings.push({ bindings, message });
    },
    info() {},
    debug() {},
    trace() {},
    silent() {},
    child() {
      return logger;
    },
    level: "debug",
  } as unknown as Logger;
  return { logger, warnings };
}

function issueKey(projectId: string, issueId: string): string {
  return `${projectId}:${issueId}`;
}

function createConfig(): AppConfig {
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
        persistExtendedHistory: true,
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
          {
            id: "review",
            whenState: "Review",
            activeState: "Reviewing",
            workflowFile: "/tmp/REVIEW_WORKFLOW.md",
            fallbackState: "Human Needed",
          },
        ],
        workflowLabels: {
          working: "llm-working",
          awaitingHandoff: "llm-awaiting-handoff",
        },
        issueKeyPrefixes: ["APP"],
        linearTeamIds: ["APP"],
        allowLabels: [],
        trustedActors: { ids: [], names: [], emails: [], emailDomains: [] },
        triggerEvents: ["statusChanged", "commentCreated", "commentUpdated"],
        branchPrefix: "app",
      },
    ],
  };
}

function createIssueRecord(overrides: Partial<TrackedIssueRecord> = {}): TrackedIssueRecord {
  return {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    issueKey: "APP-1",
    title: "Test issue",
    lifecycleStatus: "idle",
    updatedAt: "2026-03-11T10:00:00.000Z",
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
    startedAt: "2026-03-11T10:00:00.000Z",
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
    startedAt: "2026-03-11T10:00:00.000Z",
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
    createdAt: "2026-03-11T10:00:00.000Z",
    updatedAt: "2026-03-11T10:00:00.000Z",
    ...overrides,
  };
}

function createHarness() {
  const config = createConfig();
  const project = config.projects[0]!;
  const store = new FakeIssueWorkflowStore();
  const linear = new FakeLinearClient();
  const { logger, warnings } = createCaptureLogger();
  const issue = createIssueRecord({ statusCommentId: "comment-existing", activeAgentSessionId: "session-1" });
  const stageRun = createStageRun();
  const pipeline = createPipeline();
  const workspace = createWorkspace();
  store.issues.set(issueKey(issue.projectId, issue.linearIssueId), issue);
  store.stageRuns.set(stageRun.id, stageRun);
  store.pipelines.set(pipeline.id, pipeline);
  store.workspaces.set(workspace.id, workspace);
  linear.issues.set(issue.linearIssueId, {
    id: issue.linearIssueId,
    identifier: issue.issueKey,
    title: issue.title,
    stateId: "implementing",
    stateName: "Implementing",
    teamId: "APP",
    teamKey: "APP",
    workflowStates: WORKFLOW_STATES,
    labelIds: [],
    labels: [],
    teamLabels: [
      { id: "working-id", name: "llm-working" },
      { id: "awaiting-id", name: "llm-awaiting-handoff" },
    ],
  });
  const publisher = new StageLifecyclePublisher(
    config,
    { workflowCoordinator: store, issueWorkflows: store, issueControl: store },
    {
      async forProject(projectId: string) {
        return projectId === "proj" ? linear : undefined;
      },
    },
    logger,
  );

  return { publisher, store, linear, issue, stageRun, pipeline, workspace, project, warnings };
}

test("markStageActive updates Linear state, labels, and tracked issue state", async () => {
  const { publisher, project, issue, stageRun, store, linear } = createHarness();

  await publisher.markStageActive(project, issue, stageRun);

  assert.deepEqual(linear.stateTransitions, [{ issueId: "issue-1", stateName: "Implementing" }]);
  assert.deepEqual(linear.labelUpdates, [
    {
      issueId: "issue-1",
      addNames: ["llm-working"],
      removeNames: ["llm-awaiting-handoff"],
    },
  ]);
  assert.equal(store.getTrackedIssue("proj", "issue-1")?.currentLinearState, "Implementing");
  assert.equal(store.getTrackedIssue("proj", "issue-1")?.lifecycleStatus, "running");
});

test("refreshRunningStatusComment writes the running comment and tracks the returned id", async () => {
  const { publisher, linear, store } = createHarness();

  store.getTrackedIssue("proj", "issue-1")!.statusCommentId = undefined;
  await publisher.refreshRunningStatusComment("proj", "issue-1", 10, "APP-1");

  assert.equal(linear.comments.length, 1);
  assert.match(linear.comments[0]!.body, /PatchRelay is running the development workflow/);
  assert.deepEqual(store.statusCommentUpdates, [{ projectId: "proj", issueId: "issue-1", commentId: "comment-1" }]);
});

test("refreshRunningStatusComment tolerates comment write failures without mutating tracked issue state", async () => {
  const { publisher, linear, store } = createHarness();

  linear.failNextCommentUpsert = true;
  await publisher.refreshRunningStatusComment("proj", "issue-1", 10, "APP-1");

  assert.equal(store.statusCommentUpdates.length, 0);
});

test("publishStageCompletion enqueues the next requested workflow and publishes agent thought", async () => {
  const { publisher, store, linear, stageRun } = createHarness();
  store.getTrackedIssue("proj", "issue-1")!.desiredStage = "review";

  const enqueued: Array<{ projectId: string; issueId: string }> = [];
  await publisher.publishStageCompletion(stageRun, (projectId, issueId) => {
    enqueued.push({ projectId, issueId });
  });

  assert.deepEqual(enqueued, [{ projectId: "proj", issueId: "issue-1" }]);
  assert.equal(linear.agentActivities.at(-1)?.content.type, "thought");
});

test("publishStageCompletion pauses for handoff when Linear is still in the active state", async () => {
  const { publisher, store, linear, stageRun } = createHarness();
  store.stageRuns.set(stageRun.id, { ...stageRun, endedAt: "2026-03-11T10:05:00.000Z", status: "completed" });

  await publisher.publishStageCompletion(stageRun, () => {
    throw new Error("should not enqueue next stage");
  });

  assert.deepEqual(store.lifecycleUpdates, [{ projectId: "proj", issueId: "issue-1", status: "paused" }]);
  assert.deepEqual(linear.labelUpdates, [
    {
      issueId: "issue-1",
      addNames: ["llm-awaiting-handoff"],
      removeNames: ["llm-working"],
    },
  ]);
  assert.equal(linear.comments.length, 0);
  assert.ok(
    linear.agentSessionUpdates.some(
      (update) =>
        update.agentSessionId === "session-1" &&
        update.plan?.some((step) => step.content === "Review next Linear step" && step.status === "inProgress"),
    ),
  );
  assert.equal(linear.agentActivities.at(-1)?.content.type, "elicitation");
});

test("publishStageCompletion cleans up workflow labels after Linear already moved on and completes the pipeline", async () => {
  const { publisher, linear, stageRun } = createHarness();
  linear.issues.set("issue-1", {
    ...(linear.issues.get("issue-1") as LinearIssueSnapshot),
    stateName: "Done",
  });

  await publisher.publishStageCompletion(stageRun, () => {
    throw new Error("should not enqueue next stage");
  });

  assert.deepEqual(linear.labelUpdates, [
    {
      issueId: "issue-1",
      addNames: [],
      removeNames: ["llm-working", "llm-awaiting-handoff"],
    },
  ]);
  assert.ok(
    linear.agentSessionUpdates.some(
      (update) =>
        update.agentSessionId === "session-1" &&
        update.plan?.every((step) => step.status === "completed"),
    ),
  );
  assert.equal(linear.agentActivities.at(-1)?.content.type, "response");
});

test("markStageActive and publishStageCompletion no-op cleanly when workflow state or Linear client is unavailable", async () => {
  const config = createConfig();
  const store = new FakeIssueWorkflowStore();
  const issue = createIssueRecord({ projectId: "missing", linearIssueId: "issue-2" });
  const stageRun = createStageRun({ projectId: "missing", linearIssueId: "issue-2" });
  const pipeline = createPipeline({ id: 99, projectId: "missing", linearIssueId: "issue-2" });
  store.issues.set(issueKey(issue.projectId, issue.linearIssueId), issue);
  store.stageRuns.set(stageRun.id, stageRun);
  store.pipelines.set(pipeline.id, pipeline);

  const publisher = new StageLifecyclePublisher(
    config,
    { workflowCoordinator: store, issueWorkflows: store, issueControl: store },
    { async forProject() { return undefined; } },
    createCaptureLogger().logger,
  );

  await publisher.markStageActive(
    {
      ...config.projects[0]!,
      workflows: [
        {
          id: "review",
          whenState: "Review",
          activeState: "Reviewing",
          workflowFile: "/tmp/REVIEW_WORKFLOW.md",
          fallbackState: "Human Needed",
        },
      ],
    },
    issue,
    { ...stageRun, stage: "development" },
  );
  await publisher.publishStageCompletion(stageRun, () => {
    throw new Error("should not enqueue");
  });

  assert.equal(store.getTrackedIssue("missing", "issue-2")?.currentLinearState, undefined);
});

test("publishStageCompletion logs when final Linear sync fails after local completion", async () => {
  const { publisher, linear, stageRun, warnings } = createHarness();

  linear.failNextGetIssue = true;
  await publisher.publishStageCompletion(stageRun, () => undefined);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "Stage completed locally but PatchRelay could not finish the final Linear sync");
  assert.equal(warnings[0]?.bindings.stageRunId, stageRun.id);
  assert.equal(warnings[0]?.bindings.issueId, stageRun.linearIssueId);
});

test("publishStageCompletion logs when final agent activity publish fails", async () => {
  const { publisher, linear, stageRun, warnings } = createHarness();

  linear.issues.set("issue-1", {
    ...(linear.issues.get("issue-1") as LinearIssueSnapshot),
    stateName: "Done",
  });
  linear.failNextAgentActivity = true;
  await publisher.publishStageCompletion(stageRun, () => undefined);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.message, "Failed to publish Linear agent activity");
  assert.equal(warnings[0]?.bindings.issueId, stageRun.linearIssueId);
  assert.equal(warnings[0]?.bindings.activityType, "response");
});

test("publishStageCompletion avoids legacy awaiting handoff comments for delegated sessions when session delivery fails", async () => {
  const { publisher, linear, stageRun } = createHarness();

  linear.failNextAgentSessionUpdate = true;
  linear.failNextAgentActivity = true;

  await publisher.publishStageCompletion(stageRun, () => {
    throw new Error("should not enqueue");
  });

  assert.equal(linear.comments.length, 0);
});

test("publishStageCompletion writes a human-needed comment when the workflow pauses without an agent session", async () => {
  const { publisher, linear, store, stageRun } = createHarness();
  store.getTrackedIssue("proj", "issue-1")!.activeAgentSessionId = undefined;
  store.getTrackedIssue("proj", "issue-1")!.lifecycleStatus = "paused";
  store.stageRuns.set(stageRun.id, { ...stageRun, endedAt: "2026-03-11T10:05:00.000Z", status: "completed" });
  linear.issues.set("issue-1", {
    ...(linear.issues.get("issue-1") as LinearIssueSnapshot),
    stateName: "Human Needed",
  });

  await publisher.publishStageCompletion(stageRun, () => {
    throw new Error("should not enqueue");
  });

  assert.equal(linear.comments.length, 1);
  assert.match(linear.comments[0]!.body, /human-needed/);
});
