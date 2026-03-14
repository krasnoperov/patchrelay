import assert from "node:assert/strict";
import test from "node:test";
import { buildReconciliationSnapshot } from "../src/reconciliation-snapshot-builder.ts";
import type {
  AppConfig,
  CodexThreadSummary,
  IssueControlRecord,
  LinearClientProvider,
  ObligationRecord,
  RunLeaseRecord,
  WorkspaceOwnershipRecord,
} from "../src/types.ts";

class FakeCodexClient {
  readonly resumedThreads: string[] = [];

  constructor(
    private readonly threads: Map<string, CodexThreadSummary>,
    private readonly options?: { throwOnRead?: boolean; resumableThreads?: Map<string, CodexThreadSummary> },
  ) {}

  async readThread(threadId: string): Promise<CodexThreadSummary> {
    if (this.options?.throwOnRead) {
      throw new Error(`Transient read failure for ${threadId}`);
    }
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Missing thread ${threadId}`);
    }
    return thread;
  }

  async resumeThread(threadId: string): Promise<CodexThreadSummary> {
    this.resumedThreads.push(threadId);
    const resumed = this.options?.resumableThreads?.get(threadId) ?? this.threads.get(threadId);
    if (!resumed) {
      throw new Error(`Unable to resume ${threadId}`);
    }
    this.threads.set(threadId, resumed);
    return resumed;
  }
}

test("buildReconciliationSnapshot assembles ledger-native reconciliation input", async () => {
  const issueControl: IssueControlRecord = {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    desiredStage: "development",
    desiredReceiptId: 9,
    activeRunLeaseId: 2,
    activeWorkspaceOwnershipId: 3,
    serviceOwnedCommentId: "comment-1",
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const runLease: RunLeaseRecord = {
    id: 2,
    issueControlId: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceOwnershipId: 3,
    stage: "development",
    status: "running",
    threadId: "thread-1",
    turnId: "turn-1",
    startedAt: "2026-03-12T00:00:00.000Z",
  };
  const workspace: WorkspaceOwnershipRecord = {
    id: 3,
    projectId: "proj",
    linearIssueId: "issue-1",
    branchName: "app/ISSUE-1",
    worktreePath: "/tmp/worktree",
    status: "active",
    currentRunLeaseId: 2,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const obligation: ObligationRecord = {
    id: 4,
    projectId: "proj",
    linearIssueId: "issue-1",
    kind: "deliver_turn_input",
    status: "pending",
    source: "linear-comment:1",
    payloadJson: JSON.stringify({ body: "Please update the copy." }),
    runLeaseId: 2,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };

  const snapshot = await buildReconciliationSnapshot({
    config: createConfig(),
    stores: {
      issueControl: {
        getIssueControl: () => issueControl,
        upsertIssueControl: () => issueControl,
        listIssueControlsReadyForLaunch: () => [],
      },
      runLeases: {
        getRunLease: () => runLease,
        listActiveRunLeases: () => [runLease],
        createRunLease: () => runLease,
        updateRunLeaseThread: () => undefined,
        finishRunLease: () => undefined,
      },
      workspaceOwnership: {
        getWorkspaceOwnership: () => workspace,
        getWorkspaceOwnershipForIssue: () => workspace,
        upsertWorkspaceOwnership: () => workspace,
      },
      obligations: {
        enqueueObligation: () => obligation,
        getObligationByDedupeKey: () => undefined,
        listPendingObligations: () => [obligation],
        updateObligationPayloadJson: () => undefined,
        updateObligationRouting: () => undefined,
        markObligationStatus: () => undefined,
      },
    },
    codex: new FakeCodexClient(
      new Map([
        [
          "thread-1",
          {
            id: "thread-1",
            createdAt: "2026-03-12T00:00:00.000Z",
            updatedAt: "2026-03-12T00:00:00.000Z",
            status: "running",
            turns: [
              {
                id: "turn-1",
                status: "inProgress",
                items: [],
              },
            ],
          },
        ],
      ]),
    ) as never,
    linearProvider: {
      forProject: async () =>
        ({
          getIssue: async () => ({
            id: "issue-1",
            stateName: "Implementing",
          }),
        }) as never,
    } satisfies LinearClientProvider,
    runLeaseId: 2,
  });

  assert.ok(snapshot);
  assert.deepEqual(snapshot.input, {
    issue: {
      projectId: "proj",
      linearIssueId: "issue-1",
      desiredStage: "development",
      lifecycleStatus: "running",
      statusCommentId: "comment-1",
      activeRun: {
        id: 2,
        stage: "development",
        status: "running",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    },
    obligations: [
      {
        id: 4,
        kind: "deliver_turn_input",
        status: "pending",
        runId: 2,
        payload: {
          body: "Please update the copy.",
        },
      },
    ],
    policy: {
      activeLinearStateName: "Implementing",
      fallbackLinearStateName: "Human Needed",
    },
    live: {
      linear: {
        status: "known",
        issue: {
          id: "issue-1",
          stateName: "Implementing",
        },
      },
      codex: {
        status: "found",
        thread: {
          id: "thread-1",
          createdAt: "2026-03-12T00:00:00.000Z",
          updatedAt: "2026-03-12T00:00:00.000Z",
          status: "running",
          turns: [
            {
              id: "turn-1",
              status: "inProgress",
              items: [],
            },
          ],
        },
      },
    },
  });
});

test("buildReconciliationSnapshot preserves transient Codex lookup failures as retryable errors", async () => {
  const issueControl: IssueControlRecord = {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    activeRunLeaseId: 2,
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const runLease: RunLeaseRecord = {
    id: 2,
    issueControlId: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceOwnershipId: 3,
    stage: "development",
    status: "running",
    threadId: "thread-1",
    startedAt: "2026-03-12T00:00:00.000Z",
  };
  const workspace: WorkspaceOwnershipRecord = {
    id: 3,
    projectId: "proj",
    linearIssueId: "issue-1",
    branchName: "app/ISSUE-1",
    worktreePath: "/tmp/worktree",
    status: "active",
    currentRunLeaseId: 2,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };

  const snapshot = await buildReconciliationSnapshot({
    config: createConfig(),
    stores: {
      issueControl: {
        getIssueControl: () => issueControl,
        upsertIssueControl: () => issueControl,
        listIssueControlsReadyForLaunch: () => [],
      },
      runLeases: {
        getRunLease: () => runLease,
        listActiveRunLeases: () => [runLease],
        createRunLease: () => runLease,
        updateRunLeaseThread: () => undefined,
        finishRunLease: () => undefined,
      },
      workspaceOwnership: {
        getWorkspaceOwnership: () => workspace,
        getWorkspaceOwnershipForIssue: () => workspace,
        upsertWorkspaceOwnership: () => workspace,
      },
      obligations: {
        enqueueObligation: () => assert.fail("should not enqueue"),
        getObligationByDedupeKey: () => undefined,
        listPendingObligations: () => [],
        updateObligationPayloadJson: () => undefined,
        updateObligationRouting: () => undefined,
        markObligationStatus: () => undefined,
      },
    },
    codex: new FakeCodexClient(new Map(), { throwOnRead: true }) as never,
    linearProvider: {
      forProject: async () =>
        ({
          getIssue: async () => ({
            id: "issue-1",
            stateName: "Implementing",
          }),
        }) as never,
    } satisfies LinearClientProvider,
    runLeaseId: 2,
  });

  assert.equal(snapshot?.input.live?.codex?.status, "error");
  assert.match(snapshot?.input.live?.codex?.errorMessage ?? "", /Transient read failure/);
});

test("buildReconciliationSnapshot attempts to resume a missing thread from the ledger worktree", async () => {
  const issueControl: IssueControlRecord = {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    activeRunLeaseId: 2,
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const runLease: RunLeaseRecord = {
    id: 2,
    issueControlId: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceOwnershipId: 3,
    stage: "development",
    status: "running",
    threadId: "thread-1",
    startedAt: "2026-03-12T00:00:00.000Z",
  };
  const workspace: WorkspaceOwnershipRecord = {
    id: 3,
    projectId: "proj",
    linearIssueId: "issue-1",
    branchName: "app/ISSUE-1",
    worktreePath: "/tmp/worktree",
    status: "active",
    currentRunLeaseId: 2,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const codex = new FakeCodexClient(new Map(), {
    resumableThreads: new Map([
      [
        "thread-1",
        {
          id: "thread-1",
          status: "idle",
          turns: [{ id: "turn-1", status: "interrupted", items: [] }],
        },
      ],
    ]),
  });

  const snapshot = await buildReconciliationSnapshot({
    config: createConfig(),
    stores: {
      issueControl: {
        getIssueControl: () => issueControl,
        upsertIssueControl: () => issueControl,
        listIssueControlsReadyForLaunch: () => [],
      },
      runLeases: {
        getRunLease: () => runLease,
        listActiveRunLeases: () => [runLease],
        createRunLease: () => runLease,
        updateRunLeaseThread: () => undefined,
        finishRunLease: () => undefined,
      },
      workspaceOwnership: {
        getWorkspaceOwnership: () => workspace,
        getWorkspaceOwnershipForIssue: () => workspace,
        upsertWorkspaceOwnership: () => workspace,
      },
      obligations: {
        enqueueObligation: () => assert.fail("should not enqueue"),
        getObligationByDedupeKey: () => undefined,
        listPendingObligations: () => [],
        updateObligationPayloadJson: () => undefined,
        updateObligationRouting: () => undefined,
        markObligationStatus: () => undefined,
      },
    },
    codex: codex as never,
    linearProvider: {
      forProject: async () =>
        ({
          getIssue: async () => ({
            id: "issue-1",
            stateName: "Implementing",
          }),
        }) as never,
    } satisfies LinearClientProvider,
    runLeaseId: 2,
  });

  assert.deepEqual(codex.resumedThreads, ["thread-1"]);
  assert.equal(snapshot?.input.live?.codex?.status, "found");
  assert.equal(snapshot?.input.live?.codex?.thread?.turns.at(-1)?.status, "interrupted");
});

test("buildReconciliationSnapshot tolerates a missing workspace ownership record", async () => {
  const issueControl: IssueControlRecord = {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    activeRunLeaseId: 2,
    activeWorkspaceOwnershipId: 3,
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const runLease: RunLeaseRecord = {
    id: 2,
    issueControlId: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceOwnershipId: 3,
    stage: "development",
    status: "running",
    threadId: "thread-1",
    startedAt: "2026-03-12T00:00:00.000Z",
  };

  const snapshot = await buildReconciliationSnapshot({
    config: createConfig(),
    stores: {
      issueControl: {
        getIssueControl: () => issueControl,
        upsertIssueControl: () => issueControl,
        listIssueControlsReadyForLaunch: () => [],
      },
      runLeases: {
        getRunLease: () => runLease,
        listActiveRunLeases: () => [runLease],
        createRunLease: () => runLease,
        updateRunLeaseThread: () => undefined,
        finishRunLease: () => undefined,
      },
      workspaceOwnership: {
        getWorkspaceOwnership: () => undefined,
        getWorkspaceOwnershipForIssue: () => undefined,
        upsertWorkspaceOwnership: () => assert.fail("should not upsert"),
      },
      obligations: {
        enqueueObligation: () => assert.fail("should not enqueue"),
        getObligationByDedupeKey: () => undefined,
        listPendingObligations: () => [],
        updateObligationPayloadJson: () => undefined,
        updateObligationRouting: () => undefined,
        markObligationStatus: () => undefined,
      },
    },
    codex: new FakeCodexClient(
      new Map([
        [
          "thread-1",
          {
            id: "thread-1",
            createdAt: "2026-03-12T00:00:00.000Z",
            updatedAt: "2026-03-12T00:00:00.000Z",
            status: "running",
            turns: [],
          },
        ],
      ]),
    ) as never,
    linearProvider: {
      forProject: async () =>
        ({
          getIssue: async () => ({
            id: "issue-1",
            stateName: "Implementing",
          }),
        }) as never,
    } satisfies LinearClientProvider,
    runLeaseId: 2,
  });

  assert.ok(snapshot);
  assert.equal(snapshot.workspaceOwnership, undefined);
  assert.equal(snapshot.input.live?.codex?.status, "found");
});

test("buildReconciliationSnapshot preserves multiple pending obligations for the active run", async () => {
  const issueControl: IssueControlRecord = {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    activeRunLeaseId: 2,
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const runLease: RunLeaseRecord = {
    id: 2,
    issueControlId: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceOwnershipId: 3,
    stage: "development",
    status: "running",
    threadId: "thread-1",
    startedAt: "2026-03-12T00:00:00.000Z",
  };
  const workspace: WorkspaceOwnershipRecord = {
    id: 3,
    projectId: "proj",
    linearIssueId: "issue-1",
    branchName: "app/ISSUE-1",
    worktreePath: "/tmp/worktree",
    status: "active",
    currentRunLeaseId: 2,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const obligations: ObligationRecord[] = [
    {
      id: 4,
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      status: "pending",
      source: "linear-comment:1",
      payloadJson: JSON.stringify({ body: "First follow-up." }),
      runLeaseId: 2,
      createdAt: "2026-03-12T00:00:00.000Z",
      updatedAt: "2026-03-12T00:00:00.000Z",
    },
    {
      id: 5,
      projectId: "proj",
      linearIssueId: "issue-1",
      kind: "deliver_turn_input",
      status: "in_progress",
      source: "linear-comment:2",
      payloadJson: JSON.stringify({ body: "Second follow-up.", queuedInputId: 17 }),
      runLeaseId: 2,
      threadId: "thread-old",
      turnId: "turn-old",
      createdAt: "2026-03-12T00:00:01.000Z",
      updatedAt: "2026-03-12T00:00:01.000Z",
    },
  ];

  const snapshot = await buildReconciliationSnapshot({
    config: createConfig(),
    stores: {
      issueControl: {
        getIssueControl: () => issueControl,
        upsertIssueControl: () => issueControl,
        listIssueControlsReadyForLaunch: () => [],
      },
      runLeases: {
        getRunLease: () => runLease,
        listActiveRunLeases: () => [runLease],
        createRunLease: () => runLease,
        updateRunLeaseThread: () => undefined,
        finishRunLease: () => undefined,
      },
      workspaceOwnership: {
        getWorkspaceOwnership: () => workspace,
        getWorkspaceOwnershipForIssue: () => workspace,
        upsertWorkspaceOwnership: () => workspace,
      },
      obligations: {
        enqueueObligation: () => obligations[0]!,
        getObligationByDedupeKey: () => undefined,
        listPendingObligations: () => obligations,
        updateObligationPayloadJson: () => undefined,
        updateObligationRouting: () => undefined,
        markObligationStatus: () => undefined,
      },
    },
    codex: new FakeCodexClient(
      new Map([
        [
          "thread-1",
          {
            id: "thread-1",
            createdAt: "2026-03-12T00:00:00.000Z",
            updatedAt: "2026-03-12T00:00:00.000Z",
            status: "running",
            turns: [],
          },
        ],
      ]),
    ) as never,
    linearProvider: {
      forProject: async () =>
        ({
          getIssue: async () => ({
            id: "issue-1",
            stateName: "Implementing",
          }),
        }) as never,
    } satisfies LinearClientProvider,
    runLeaseId: 2,
  });

  assert.deepEqual(snapshot?.input.obligations, [
    {
      id: 4,
      kind: "deliver_turn_input",
      status: "pending",
      runId: 2,
      payload: {
        body: "First follow-up.",
      },
    },
    {
      id: 5,
      kind: "deliver_turn_input",
      status: "in_progress",
      runId: 2,
      threadId: "thread-old",
      turnId: "turn-old",
      payload: {
        body: "Second follow-up.",
        queuedInputId: 17,
      },
    },
  ]);
});

test("buildReconciliationSnapshot tolerates missing workspace ownership and still returns pending obligations", async () => {
  const issueControl: IssueControlRecord = {
    id: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    activeRunLeaseId: 2,
    activeWorkspaceOwnershipId: 99,
    lifecycleStatus: "running",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };
  const runLease: RunLeaseRecord = {
    id: 2,
    issueControlId: 1,
    projectId: "proj",
    linearIssueId: "issue-1",
    workspaceOwnershipId: 99,
    stage: "development",
    status: "running",
    threadId: "thread-1",
    turnId: "turn-1",
    startedAt: "2026-03-12T00:00:00.000Z",
  };
  const obligation: ObligationRecord = {
    id: 4,
    projectId: "proj",
    linearIssueId: "issue-1",
    kind: "deliver_turn_input",
    status: "pending",
    source: "linear-comment:1",
    payloadJson: JSON.stringify({ body: "Please update the copy." }),
    runLeaseId: 2,
    createdAt: "2026-03-12T00:00:00.000Z",
    updatedAt: "2026-03-12T00:00:00.000Z",
  };

  const snapshot = await buildReconciliationSnapshot({
    config: createConfig(),
    stores: {
      issueControl: {
        getIssueControl: () => issueControl,
        upsertIssueControl: () => issueControl,
        listIssueControlsReadyForLaunch: () => [],
      },
      runLeases: {
        getRunLease: () => runLease,
        listActiveRunLeases: () => [runLease],
        createRunLease: () => runLease,
        updateRunLeaseThread: () => undefined,
        finishRunLease: () => undefined,
      },
      workspaceOwnership: {
        getWorkspaceOwnership: () => undefined,
        getWorkspaceOwnershipForIssue: () => undefined,
        upsertWorkspaceOwnership: () => assert.fail("should not upsert workspace ownership"),
      },
      obligations: {
        enqueueObligation: () => obligation,
        getObligationByDedupeKey: () => undefined,
        listPendingObligations: () => [obligation],
        updateObligationPayloadJson: () => undefined,
        updateObligationRouting: () => undefined,
        markObligationStatus: () => undefined,
      },
    },
    codex: new FakeCodexClient(
      new Map([
        [
          "thread-1",
          {
            id: "thread-1",
            createdAt: "2026-03-12T00:00:00.000Z",
            updatedAt: "2026-03-12T00:00:00.000Z",
            status: "running",
            turns: [
              {
                id: "turn-1",
                status: "inProgress",
                items: [],
              },
            ],
          },
        ],
      ]),
    ) as never,
    linearProvider: {
      forProject: async () =>
        ({
          getIssue: async () => ({
            id: "issue-1",
            stateName: "Implementing",
          }),
        }) as never,
    } satisfies LinearClientProvider,
    runLeaseId: 2,
  });

  assert.ok(snapshot);
  assert.equal(snapshot.workspaceOwnership, undefined);
  assert.deepEqual(snapshot.input.obligations, [
    {
      id: 4,
      kind: "deliver_turn_input",
      status: "pending",
      runId: 2,
      payload: {
        body: "Please update the copy.",
      },
    },
  ]);
});

function createConfig(): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 3000,
      healthPath: "/health",
      readinessPath: "/ready",
    },
    ingress: {
      linearWebhookPath: "/linear/webhook",
      maxBodyBytes: 1024,
      maxTimestampSkewSeconds: 60,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: "/tmp/patchrelay.log",
    },
    database: {
      path: "/tmp/patchrelay.db",
      wal: true,
    },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client",
        clientSecret: "secret",
        redirectUri: "https://example.com/oauth/callback",
        scopes: [],
        actor: "app",
      },
      tokenEncryptionKey: "x".repeat(32),
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
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
            whenState: "Todo",
            activeState: "Implementing",
            fallbackState: "Human Needed",
            workflowFile: "WORKFLOW.md",
          },
        ],
        issueKeyPrefixes: ["ISSUE"],
        linearTeamIds: ["team-1"],
        allowLabels: [],
        triggerEvents: ["delegateChanged"],
        branchPrefix: "app",
      },
    ],
  };
}
