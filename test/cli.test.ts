import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { runCli } from "../src/cli/index.js";
import { CliDataAccess } from "../src/cli/data.js";
import { PatchRelayDatabase } from "../src/db.js";
import { buildHttpServer } from "../src/http.js";
import type { AppConfig } from "../src/types.js";

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
      readinessPath: "/ready",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: path.join(baseDir, "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "app",
      },
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
        serviceName: "patchrelay-test",
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflowFiles: {
          development: path.join(baseDir, "DEVELOPMENT_WORKFLOW.md"),
          review: path.join(baseDir, "REVIEW_WORKFLOW.md"),
          deploy: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
          cleanup: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
        },
        workflowStatuses: {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          developmentActive: "Implementing",
          reviewActive: "Reviewing",
          deployActive: "Deploying",
          cleanup: "Cleanup",
          humanNeeded: "Human Needed",
          done: "Done",
        },
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
  };
}

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
    read(): string {
      return buffer;
    },
  };
}

function seedDatabase(db: PatchRelayDatabase, config: AppConfig): void {
  mkdirSync(config.projects[0].worktreeRoot, { recursive: true });

  db.upsertTrackedIssue({
    projectId: "usertold",
    linearIssueId: "issue-1",
    issueKey: "USE-54",
    title: "Playback-first evidence workspace",
    issueUrl: "https://linear.example/USE-54",
    currentLinearState: "Human Needed",
    desiredStage: "deploy",
    desiredWebhookId: "delivery-1",
    lifecycleStatus: "failed",
    lastWebhookAt: "2026-03-09T08:00:00.000Z",
  });
  const completed = db.claimStageRun({
    projectId: "usertold",
    linearIssueId: "issue-1",
    stage: "deploy",
    triggerWebhookId: "delivery-1",
    branchName: "use/USE-54-playback-first-evidence-workspace",
    worktreePath: path.join(config.projects[0].worktreeRoot, "USE-54"),
    workflowFile: config.projects[0].workflowFiles.deploy,
    promptText: "Deploy it",
  });
  assert.ok(completed);
  db.updateStageRunThread({ stageRunId: completed.stageRun.id, threadId: "thread-54", turnId: "turn-54" });
  db.saveThreadEvent({
    stageRunId: completed.stageRun.id,
    threadId: "thread-54",
    turnId: "turn-54",
    method: "turn/started",
    eventJson: JSON.stringify({ threadId: "thread-54", turnId: "turn-54" }),
  });
  db.finishStageRun({
    stageRunId: completed.stageRun.id,
    status: "failed",
    threadId: "thread-54",
    turnId: "turn-54",
    summaryJson: JSON.stringify({
      latestAssistantMessage: "Deploy did not complete because auth was missing.",
    }),
    reportJson: JSON.stringify({
      issueKey: "USE-54",
      stage: "deploy",
      status: "failed",
      threadId: "thread-54",
      turnId: "turn-54",
      prompt: "Deploy it",
      workflowFile: config.projects[0].workflowFiles.deploy,
      assistantMessages: ["Deploy did not complete because auth was missing."],
      plans: [],
      reasoning: [],
      commands: [{ command: "npm run deploy", cwd: "/tmp/use-54", status: "failed", exitCode: 1 }],
      fileChanges: [{ path: "src/session-detail.tsx", kind: "update" }],
      toolCalls: [{ type: "dynamic", name: "apply_patch", status: "completed" }],
      eventCounts: { "turn/started": 1 },
    }),
  });

  db.upsertTrackedIssue({
    projectId: "usertold",
    linearIssueId: "issue-2",
    issueKey: "USE-55",
    title: "Queued review issue",
    currentLinearState: "Review",
    lifecycleStatus: "idle",
    lastWebhookAt: "2026-03-09T09:00:00.000Z",
  });
  db.setIssueDesiredStage("usertold", "issue-2", undefined);

  db.upsertTrackedIssue({
    projectId: "usertold",
    linearIssueId: "issue-3",
    issueKey: "USE-56",
    title: "Running stage",
    currentLinearState: "Start",
    desiredStage: "development",
    desiredWebhookId: "delivery-3",
    lifecycleStatus: "running",
    lastWebhookAt: "2026-03-09T10:00:00.000Z",
  });
  const running = db.claimStageRun({
    projectId: "usertold",
    linearIssueId: "issue-3",
    stage: "development",
    triggerWebhookId: "delivery-3",
    branchName: "use/USE-56-running-stage",
    worktreePath: path.join(config.projects[0].worktreeRoot, "USE-56"),
    workflowFile: config.projects[0].workflowFiles.development,
    promptText: "Build it",
  });
  assert.ok(running);
  db.updateStageRunThread({ stageRunId: running.stageRun.id, threadId: "thread-56", turnId: "turn-56" });
}

function seedRuntimeFiles(config: AppConfig): void {
  mkdirSync(config.projects[0].repoPath, { recursive: true });
  for (const workflowFile of Object.values(config.projects[0].workflowFiles)) {
    writeFileSync(workflowFile, "# workflow\n", "utf8");
  }
}

test("cli inspect, worktree, open, events, and report render stored issue details", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    const data = new CliDataAccess(config, { db });

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    assert.equal(await runCli(["inspect", "USE-54"], { config, data, stdout: stdout.stream, stderr: stderr.stream }), 0);
    assert.match(stdout.read(), /USE-54  Human Needed/);
    assert.match(stdout.read(), /Deploy did not complete because auth was missing/);

    const worktreeOut = createBufferStream();
    assert.equal(await runCli(["worktree", "USE-54", "--cd"], { config, data, stdout: worktreeOut.stream, stderr: stderr.stream }), 0);
    assert.equal(worktreeOut.read().trim(), path.join(config.projects[0].worktreeRoot, "USE-54"));

    const openOut = createBufferStream();
    assert.equal(await runCli(["open", "USE-54", "--print"], { config, data, stdout: openOut.stream, stderr: stderr.stream }), 0);
    assert.match(openOut.read(), /codex --dangerously-bypass-approvals-and-sandbox resume thread-54/);

    const reportOut = createBufferStream();
    assert.equal(await runCli(["report", "USE-54"], { config, data, stdout: reportOut.stream, stderr: stderr.stream }), 0);
    assert.match(reportOut.read(), /deploy #1 failed/);
    assert.match(reportOut.read(), /npm run deploy/);

    const eventsOut = createBufferStream();
    assert.equal(await runCli(["events", "USE-54"], { config, data, stdout: eventsOut.stream, stderr: stderr.stream }), 0);
    assert.match(eventsOut.read(), /turn\/started/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli open launches codex in the issue worktree", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    const data = new CliDataAccess(config, { db });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exitCode = await runCli(["open", "USE-54"], {
      config,
      data,
      stdout: createBufferStream().stream,
      stderr: createBufferStream().stream,
      runInteractive: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    });

    assert.equal(exitCode, 0);
    assert.deepEqual(calls, [
      {
        command: "codex",
        args: [
          "--dangerously-bypass-approvals-and-sandbox",
          "resume",
          "-C",
          path.join(config.projects[0].worktreeRoot, "USE-54"),
          "thread-54",
        ],
      },
    ]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli list and retry cover operator control flows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-"));
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    const data = new CliDataAccess(config, { db });

    const failedList = createBufferStream();
    assert.equal(await runCli(["list", "--failed"], { config, data, stdout: failedList.stream, stderr: createBufferStream().stream }), 0);
    assert.match(failedList.read(), /USE-54/);
    assert.doesNotMatch(failedList.read(), /USE-55/);

    const retryOut = createBufferStream();
    assert.equal(
      await runCli(["retry", "USE-55", "--reason", "operator retry"], {
        config,
        data,
        stdout: retryOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(retryOut.read(), /Queued stage: review/);

    const updated = db.getTrackedIssue("usertold", "issue-2");
    assert.equal(updated?.desiredStage, "review");
    assert.equal(updated?.lifecycleStatus, "queued");

    const inspectJson = createBufferStream();
    assert.equal(await runCli(["USE-54", "--json"], { config, data, stdout: inspectJson.stream, stderr: createBufferStream().stream }), 0);
    assert.match(inspectJson.read(), /"issueKey": "USE-54"/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli doctor reports deployment readiness problems", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-doctor-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const exitCode = await runCli(["doctor"], {
      config,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    assert.equal(exitCode, 1);
    assert.match(stdout.read(), /PatchRelay doctor/);
    assert.match(stdout.read(), /FAIL \[project:usertold:workflow:development\]/);
    assert.equal(stderr.read(), "");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli doctor reports preflight status", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-doctor-"));
  try {
    const config = {
      ...createConfig(baseDir),
      linear: {
        ...createConfig(baseDir).linear,
        webhookSecret: "secret",
      },
      runner: {
        ...createConfig(baseDir).runner,
        gitBin: "true",
        codex: {
          ...createConfig(baseDir).runner.codex,
          bin: "true",
        },
      },
    };
    seedRuntimeFiles(config);

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    const exitCode = await runCli(["doctor"], { config, stdout: stdout.stream, stderr: stderr.stream });

    assert.equal(exitCode, 0);
    assert.match(stdout.read(), /PASS \[linear\] Linear webhook secret is configured/);
    assert.match(stdout.read(), /PASS \[linear_oauth\] Linear OAuth is configured with actor=app/);

    const jsonOut = createBufferStream();
    assert.equal(await runCli(["doctor", "--json"], { config, stdout: jsonOut.stream, stderr: stderr.stream }), 0);
    assert.match(jsonOut.read(), /"ok": true/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli connect, installations, and link-installation cover OAuth installation flows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-installations-"));
  try {
    const config = {
      ...createConfig(baseDir),
      linear: {
        ...createConfig(baseDir).linear,
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "app" as const,
        },
        tokenEncryptionKey: "encryption-secret",
      },
    };
    const data = {
      async connect(projectId?: string) {
        return {
          state: "state-1",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          ...(projectId ? { projectId } : {}),
        };
      },
      async connectStatus() {
        return {
          state: "state-1",
          status: "completed" as const,
          projectId: "usertold",
          installation: { id: 1, workspaceName: "Workspace One" },
        };
      },
      async listInstallations() {
        return {
          installations: [
            {
              installation: {
                id: 1,
                workspaceName: "Workspace One",
                workspaceKey: "WS1",
                actorName: "PatchRelay App",
                actorId: "actor-1",
              },
              linkedProjects: [],
            },
          ],
        };
      },
      async linkInstallation(projectId: string, installationId: number) {
        return { projectId, installationId };
      },
      async unlinkInstallation(projectId: string) {
        return { projectId };
      },
      async webhookInstructions() {
        return {
          projectId: "usertold",
          installationId: 1,
          webhookUrl: "http://127.0.0.1:8787/webhooks/linear",
          webhookPath: "/webhooks/linear",
          sharedSecretConfigured: false,
        };
      },
    } as unknown as CliDataAccess;

    const connectOut = createBufferStream();
    assert.equal(
      await runCli(["connect", "--project", "usertold"], {
        config,
        data,
        stdout: connectOut.stream,
        stderr: createBufferStream().stream,
        openExternal: async () => true,
        connectPollIntervalMs: 1,
      }),
      0,
    );
    assert.match(connectOut.read(), /Opened browser for Linear OAuth/);
    assert.match(connectOut.read(), /Connected Workspace One for project usertold/);

    const installationsOut = createBufferStream();
    assert.equal(
      await runCli(["installations"], {
        config,
        data,
        stdout: installationsOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(installationsOut.read(), /Workspace One/);

    const linkOut = createBufferStream();
    assert.equal(
      await runCli(["link-installation", "usertold", "1"], {
        config,
        data,
        stdout: linkOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(linkOut.read(), /Linked usertold to installation 1/);

    const unlinkOut = createBufferStream();
    assert.equal(
      await runCli(["unlink-installation", "usertold"], {
        config,
        data,
        stdout: unlinkOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(unlinkOut.read(), /Removed installation link/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli OAuth operator commands support json output and validation failures", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-installations-"));
  try {
    const config = {
      ...createConfig(baseDir),
      linear: {
        ...createConfig(baseDir).linear,
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "app" as const,
        },
        tokenEncryptionKey: "encryption-secret",
      },
    };
    const data = {
      async connect(projectId?: string) {
        if (projectId === "missing-project") {
          throw new Error("Unknown project: missing-project");
        }
        return {
          state: "state-1",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          ...(projectId ? { projectId } : {}),
        };
      },
      async listInstallations() {
        return {
          installations: [
            {
              installation: {
                id: 1,
                workspaceName: "Workspace One",
                workspaceKey: "WS1",
                actorName: "PatchRelay App",
                actorId: "actor-1",
              },
              linkedProjects: ["usertold"],
            },
          ],
        };
      },
      async linkInstallation(projectId: string, installationId: number) {
        if (projectId === "missing-project") {
          throw new Error("Unknown project: missing-project");
        }
        if (installationId === 999) {
          throw new Error("Unknown installation: 999");
        }
        return { projectId, installationId };
      },
      async unlinkInstallation(projectId: string) {
        if (projectId === "missing-project") {
          throw new Error("Unknown project: missing-project");
        }
        return { projectId };
      },
      async webhookInstructions(projectId: string) {
        if (projectId === "missing-project") {
          throw new Error("Unknown project: missing-project");
        }
        return {
          projectId,
          installationId: 1,
          webhookUrl: "http://127.0.0.1:8787/webhooks/linear",
          webhookPath: "/webhooks/linear",
          sharedSecretConfigured: true,
        };
      },
    } as unknown as CliDataAccess;

    const connectJson = createBufferStream();
    assert.equal(
      await runCli(["connect", "--project", "usertold", "--json"], {
        config,
        data,
        stdout: connectJson.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(connectJson.read()), {
      state: "state-1",
      authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
      redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
      projectId: "usertold",
    });

    const linkJson = createBufferStream();
    assert.equal(
      await runCli(["link-installation", "usertold", "1", "--json"], {
        config,
        data,
        stdout: linkJson.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(linkJson.read()), {
      projectId: "usertold",
      installationId: 1,
    });

    const installationsJson = createBufferStream();
    assert.equal(
      await runCli(["installations", "--json"], {
        config,
        data,
        stdout: installationsJson.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(installationsJson.read()), {
      installations: [
        {
          installation: {
            id: 1,
            workspaceName: "Workspace One",
            workspaceKey: "WS1",
            actorName: "PatchRelay App",
            actorId: "actor-1",
          },
          linkedProjects: ["usertold"],
        },
      ],
    });

    const unlinkJson = createBufferStream();
    assert.equal(
      await runCli(["unlink-installation", "usertold", "--json"], {
        config,
        data,
        stdout: unlinkJson.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(unlinkJson.read()), {
      projectId: "usertold",
    });

    const webhookJson = createBufferStream();
    assert.equal(
      await runCli(["webhook", "usertold", "--show-secret", "--json"], {
        config: {
          ...config,
          linear: {
            ...config.linear,
            webhookSecret: "webhook-secret",
          },
        },
        data,
        stdout: webhookJson.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(webhookJson.read()), {
      projectId: "usertold",
      installationId: 1,
      webhookUrl: "http://127.0.0.1:8787/webhooks/linear",
      webhookPath: "/webhooks/linear",
      sharedSecretConfigured: true,
      webhookSecret: "webhook-secret",
    });

    const connectError = createBufferStream();
    assert.equal(
      await runCli(["connect", "--project", "missing-project"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: connectError.stream,
      }),
      1,
    );
    assert.match(connectError.read(), /Unknown project: missing-project/);

    const linkError = createBufferStream();
    assert.equal(
      await runCli(["link-installation", "usertold", "999"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: linkError.stream,
      }),
      1,
    );
    assert.match(linkError.read(), /Unknown installation: 999/);

    const webhookError = createBufferStream();
    assert.equal(
      await runCli(["webhook", "missing-project"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: webhookError.stream,
      }),
      1,
    );
    assert.match(webhookError.read(), /Unknown project: missing-project/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli installation commands use the local HTTP service end to end", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-http-"));
  try {
    const config = {
      ...createConfig(baseDir),
      linear: {
        ...createConfig(baseDir).linear,
        webhookSecret: "webhook-secret",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:0/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "app" as const,
        },
        tokenEncryptionKey: "encryption-secret",
      },
    };

    let oauthPollCount = 0;
    const links = new Map<string, number>();
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true }),
        createLinearOAuthStart: ({ projectId }: { projectId?: string } = {}) => ({
          state: "state-http",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-http",
          redirectUri: config.linear.oauth!.redirectUri,
          ...(projectId ? { projectId } : {}),
        }),
        getLinearOAuthStateStatus: (state: string) => {
          if (state !== "state-http") {
            return undefined;
          }
          oauthPollCount += 1;
          return oauthPollCount < 2
            ? { state, status: "pending" as const, projectId: "usertold" }
            : {
                state,
                status: "completed" as const,
                projectId: "usertold",
                installation: { id: 7, workspaceName: "Workspace Seven" },
              };
        },
        listLinearInstallations: () => [
          {
            installation: { id: 7, workspaceName: "Workspace Seven" },
            linkedProjects: [...links.entries()].filter(([, id]) => id === 7).map(([projectId]) => projectId),
          },
        ],
        linkProjectInstallation: (projectId: string, installationId: number) => {
          links.set(projectId, installationId);
          return { projectId, installationId };
        },
        unlinkProjectInstallation: (projectId: string) => {
          links.delete(projectId);
          return undefined;
        },
      } as never,
      pino({ enabled: false }),
    );

    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === "object");
    config.server.port = address.port;
    config.linear.oauth.redirectUri = `http://127.0.0.1:${address.port}/oauth/linear/callback`;

    const data = new CliDataAccess(config);

    const connectOut = createBufferStream();
    assert.equal(
      await runCli(["connect", "--project", "usertold", "--no-open"], {
        config,
        data,
        stdout: connectOut.stream,
        stderr: createBufferStream().stream,
        connectPollIntervalMs: 1,
      }),
      0,
    );
    assert.match(connectOut.read(), /Connected Workspace Seven for project usertold/);

    const linkOut = createBufferStream();
    assert.equal(
      await runCli(["link-installation", "usertold", "7"], {
        config,
        data,
        stdout: linkOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.equal(links.get("usertold"), 7);

    const installationsOut = createBufferStream();
    assert.equal(
      await runCli(["installations"], {
        config,
        data,
        stdout: installationsOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(installationsOut.read(), /Workspace Seven/);
    assert.match(installationsOut.read(), /projects=usertold/);

    const webhookOut = createBufferStream();
    assert.equal(
      await runCli(["webhook", "usertold"], {
        config,
        data,
        stdout: webhookOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(webhookOut.read(), /Webhook URL: http:\/\/127\.0\.0\.1:/);

    const unlinkOut = createBufferStream();
    assert.equal(
      await runCli(["unlink-installation", "usertold"], {
        config,
        data,
        stdout: unlinkOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.equal(links.has("usertold"), false);

    data.close();
    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
