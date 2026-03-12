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
  constructor(
    private readonly threads: Map<string, CodexThreadSummary>,
    private readonly options?: { throwOnRead?: boolean },
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
