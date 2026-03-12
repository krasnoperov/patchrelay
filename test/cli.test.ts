import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { runCli } from "../src/cli/index.ts";
import { loadConfig } from "../src/config.ts";
import { CliDataAccess } from "../src/cli/data.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import { buildHttpServer } from "../src/http.ts";
import type { AppConfig } from "../src/types.ts";

function createWorkflows(baseDir: string) {
  return [
    {
      id: "development",
      whenState: "Start",
      activeState: "Implementing",
      workflowFile: path.join(baseDir, "DEVELOPMENT_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "review",
      whenState: "Review",
      activeState: "Reviewing",
      workflowFile: path.join(baseDir, "REVIEW_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "deploy",
      whenState: "Deploy",
      activeState: "Deploying",
      workflowFile: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
    {
      id: "cleanup",
      whenState: "Cleanup",
      activeState: "Cleaning Up",
      workflowFile: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
      fallbackState: "Human Needed",
    },
  ];
}

function getWorkflowFile(config: AppConfig, workflowId: string): string {
  const workflow = config.projects[0]?.workflows.find((entry) => entry.id === workflowId);
  assert.ok(workflow);
  return workflow.workflowFile;
}

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      publicBaseUrl: "https://patchrelay.example.com",
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
        workflows: createWorkflows(baseDir),
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

function modeOf(filePath: string): number {
  return statSync(filePath).mode & 0o777;
}

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };

  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function seedDatabase(db: PatchRelayDatabase, config: AppConfig): void {
  mkdirSync(config.projects[0].worktreeRoot, { recursive: true });

  db.issueWorkflows.upsertTrackedIssue({
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
  const completed = db.issueWorkflows.claimStageRun({
    projectId: "usertold",
    linearIssueId: "issue-1",
    stage: "deploy",
    triggerWebhookId: "delivery-1",
    branchName: "use/USE-54-playback-first-evidence-workspace",
    worktreePath: path.join(config.projects[0].worktreeRoot, "USE-54"),
    workflowFile: getWorkflowFile(config, "deploy"),
    promptText: "Deploy it",
  });
  assert.ok(completed);
  db.issueWorkflows.updateStageRunThread({ stageRunId: completed.stageRun.id, threadId: "thread-54", turnId: "turn-54" });
  db.stageEvents.saveThreadEvent({
    stageRunId: completed.stageRun.id,
    threadId: "thread-54",
    turnId: "turn-54",
    method: "turn/started",
    eventJson: JSON.stringify({ threadId: "thread-54", turnId: "turn-54" }),
  });
  db.issueWorkflows.finishStageRun({
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
      workflowFile: getWorkflowFile(config, "deploy"),
      assistantMessages: ["Deploy did not complete because auth was missing."],
      plans: [],
      reasoning: [],
      commands: [{ command: "npm run deploy", cwd: "/tmp/use-54", status: "failed", exitCode: 1 }],
      fileChanges: [{ path: "src/session-detail.tsx", kind: "update" }],
      toolCalls: [{ type: "dynamic", name: "apply_patch", status: "completed" }],
      eventCounts: { "turn/started": 1 },
    }),
  });

  db.issueWorkflows.upsertTrackedIssue({
    projectId: "usertold",
    linearIssueId: "issue-2",
    issueKey: "USE-55",
    title: "Queued review issue",
    currentLinearState: "Review",
    lifecycleStatus: "idle",
    lastWebhookAt: "2026-03-09T09:00:00.000Z",
  });
  db.issueWorkflows.setIssueDesiredStage("usertold", "issue-2", undefined);

  db.issueWorkflows.upsertTrackedIssue({
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
  const running = db.issueWorkflows.claimStageRun({
    projectId: "usertold",
    linearIssueId: "issue-3",
    stage: "development",
    triggerWebhookId: "delivery-3",
    branchName: "use/USE-56-running-stage",
    worktreePath: path.join(config.projects[0].worktreeRoot, "USE-56"),
    workflowFile: getWorkflowFile(config, "development"),
    promptText: "Build it",
  });
  assert.ok(running);
  db.issueWorkflows.updateStageRunThread({ stageRunId: running.stageRun.id, threadId: "thread-56", turnId: "turn-56" });
}

function seedRuntimeFiles(config: AppConfig): void {
  mkdirSync(config.projects[0].repoPath, { recursive: true });
  for (const workflow of config.projects[0].workflows) {
    writeFileSync(workflow.workflowFile, "# workflow\n", "utf8");
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
    assert.match(stdout.read(), /USE-54 {2}Human Needed/);
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

    const updated = db.issueWorkflows.getTrackedIssue("usertold", "issue-2");
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

test("cli help explains the setup sequence and default behavior", async () => {
  const stdout = createBufferStream();
  const stderr = createBufferStream();

  assert.equal(await runCli([], { stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stderr.read(), "");
  assert.match(stdout.read(), /First-time setup:/);
  assert.match(stdout.read(), /patchrelay init <public-https-url>/);
  assert.match(stdout.read(), /patchrelay project apply <id> <repo-path>/);
  assert.match(
    stdout.read(),
    /In the normal\s+case you only need the public URL, the required secrets, and at least one project\./,
  );
});

test("cli init writes XDG config files and install-service manages the user unit", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-init-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
      },
      async () => {
        const initOut = createBufferStream();
        const initCommands: string[] = [];
        assert.equal(
          await runCli(["init", "patchrelay.example.com"], {
            stdout: initOut.stream,
            stderr: createBufferStream().stream,
            runInteractive: async (command, args) => {
              initCommands.push([command, ...args].join(" "));
              return 0;
            },
          }),
          0,
        );
        const initText = initOut.read();
        assert.match(initText, /Config directory:/);
        assert.match(initText, /Public base URL: https:\/\/patchrelay\.example\.com/);
        assert.match(initText, /Webhook URL: https:\/\/patchrelay\.example\.com\/webhooks\/linear/);
        assert.match(initText, /Config file contains only machine-level essentials/);
        assert.match(initText, /The user service and config watcher are installed for you/);
        assert.match(initText, /Open Linear Settings > API > Applications/);
        assert.match(initText, /Run `patchrelay project apply <id> <repo-path>`/);

        const runtimeEnvPath = path.join(configHome, "patchrelay", "runtime.env");
        const serviceEnvPath = path.join(configHome, "patchrelay", "service.env");
        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
        const runtimeEnvContents = readFileSync(runtimeEnvPath, "utf8");
        const serviceEnvContents = readFileSync(serviceEnvPath, "utf8");
        assert.match(serviceEnvContents, /^LINEAR_WEBHOOK_SECRET=[0-9a-f]{64}$/m);
        assert.match(serviceEnvContents, /^PATCHRELAY_TOKEN_ENCRYPTION_KEY=[0-9a-f]{64}$/m);
        assert.doesNotMatch(serviceEnvContents, /replace-with-linear-webhook-secret/);
        assert.doesNotMatch(serviceEnvContents, /replace-with-long-random-secret/);
        if (process.platform !== "win32") {
          assert.equal(modeOf(serviceEnvPath), 0o600);
        }
        assert.match(runtimeEnvContents, /PATCHRELAY_DB_PATH/);
        const configContents = readFileSync(configPath, "utf8");
        assert.equal(configContents.includes('"public_base_url": "https://patchrelay.example.com"'), true);
        assert.equal(configContents.includes('"projects"'), false);
        assert.equal(configContents.includes(path.join(dataHome, "patchrelay", "worktrees")), false);
        assert.deepEqual(initCommands, [
          "systemctl --user daemon-reload",
          "systemctl --user enable --now patchrelay.path",
          "systemctl --user enable patchrelay.service",
          "systemctl --user reload-or-restart patchrelay.service",
        ]);

        const installOut = createBufferStream();
        assert.equal(
          await runCli(["install-service", "--write-only"], {
            stdout: installOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        const unitPath = path.join(configHome, "systemd", "user", "patchrelay.service");
        const reloadUnitPath = path.join(configHome, "systemd", "user", "patchrelay-reload.service");
        const pathUnitPath = path.join(configHome, "systemd", "user", "patchrelay.path");
        const unit = readFileSync(unitPath, "utf8");
        const reloadUnit = readFileSync(reloadUnitPath, "utf8");
        const pathUnit = readFileSync(pathUnitPath, "utf8");
        assert.match(unit, /ExecStart=\/usr\/bin\/env patchrelay serve/);
        assert.match(unit, new RegExp(`Environment=PATCHRELAY_CONFIG=${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(unit, /EnvironmentFile=-.*runtime\.env/);
        assert.match(unit, /EnvironmentFile=.*service\.env/);
        assert.match(reloadUnit, /reload-or-restart patchrelay\.service/);
        assert.match(pathUnit, /Unit=patchrelay-reload\.service/);
        assert.match(pathUnit, /PathChanged=.*runtime\.env/);
        assert.match(pathUnit, /PathChanged=.*service\.env/);

        const commands: string[] = [];
        assert.equal(
          await runCli(["restart-service", "--json"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async (command, args) => {
              commands.push([command, ...args].join(" "));
              return 0;
            },
          }),
          0,
        );
        assert.deepEqual(commands, [
          "systemctl --user daemon-reload",
          "systemctl --user reload-or-restart patchrelay.service",
        ]);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli init requires a public base URL", async () => {
  const stderr = createBufferStream();
  assert.equal(await runCli(["init"], { stdout: createBufferStream().stream, stderr: stderr.stream }), 1);
  assert.match(stderr.read(), /patchrelay init requires <public-base-url>/);
  assert.match(stderr.read(), /PatchRelay must know the public HTTPS origin/);
});

test("cli init updates the saved public base URL on rerun", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-init-rerun-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
      },
      async () => {
        assert.equal(
          await runCli(["init", "first.example.com"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        const rerunOut = createBufferStream();
        assert.equal(
          await runCli(["init", "relay.acme.dev"], {
            stdout: rerunOut.stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        const rerunText = rerunOut.read();
        assert.match(rerunText, /Config file: .* \(updated\)/);
        assert.match(rerunText, /Public base URL: https:\/\/relay\.acme\.dev/);
        assert.doesNotMatch(rerunText, /patchrelay\.example\.com/);

        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
        const configContents = readFileSync(configPath, "utf8");
        assert.equal(configContents.includes('"public_base_url": "https://relay.acme.dev"'), true);
        assert.equal(configContents.includes('"public_base_url": "https://first.example.com"'), false);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli project apply appends a minimal project to config", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-project-add-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const repoPath = path.join(baseDir, "repo");

  try {
    mkdirSync(repoPath, { recursive: true });
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
      },
      async () => {
        assert.equal(
          await runCli(["init", "relay.example.com"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        const projectOut = createBufferStream();
        assert.equal(
          await runCli(["project", "apply", "usertold", repoPath, "--issue-prefix", "USE", "--no-connect"], {
            stdout: projectOut.stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );
        assert.match(projectOut.read(), /Created project usertold/);
        assert.match(projectOut.read(), /Linear connect was skipped because PatchRelay is not ready yet:/);

        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
        const configContents = readFileSync(configPath, "utf8");
        assert.match(configContents, /"projects"\s*:/);
        assert.match(configContents, /"id"\s*:\s*"usertold"/);
        assert.match(configContents, /"repo_path"\s*:/);
        assert.match(configContents, /"issue_key_prefixes"\s*:/);

        const config = loadConfig(configPath, { profile: "write_config" });
        assert.equal(config.projects[0]?.id, "usertold");
        assert.equal(config.projects[0]?.repoPath, repoPath);
        assert.equal(config.projects[0]?.branchPrefix, "usertold");
        assert.equal(config.projects[0]?.worktreeRoot, path.join(dataHome, "patchrelay", "worktrees", "usertold"));
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli project apply is idempotent and can skip connect until env is ready", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-project-apply-idempotent-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const repoPath = path.join(baseDir, "repo");

  try {
    mkdirSync(repoPath, { recursive: true });
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
        LINEAR_WEBHOOK_SECRET: undefined,
        PATCHRELAY_TOKEN_ENCRYPTION_KEY: undefined,
        LINEAR_OAUTH_CLIENT_ID: undefined,
        LINEAR_OAUTH_CLIENT_SECRET: undefined,
      },
      async () => {
        assert.equal(
          await runCli(["init", "relay.example.com"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        const projectOut = createBufferStream();
        assert.equal(
          await runCli(["project", "apply", "usertold", repoPath, "--issue-prefix", "USE"], {
            stdout: projectOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        assert.match(projectOut.read(), /Linear connect was skipped because PatchRelay is not ready yet:/);
        assert.match(projectOut.read(), /Fix the failures above and rerun `patchrelay project apply`/);

        const rerunOut = createBufferStream();
        assert.equal(
          await runCli(["project", "apply", "usertold", repoPath, "--issue-prefix", "USE"], {
            stdout: rerunOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        assert.match(rerunOut.read(), /Verified project usertold/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli project apply requires routing when adding a second project", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-project-add-routing-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const firstRepoPath = path.join(baseDir, "repo-one");
  const secondRepoPath = path.join(baseDir, "repo-two");

  try {
    mkdirSync(firstRepoPath, { recursive: true });
    mkdirSync(secondRepoPath, { recursive: true });
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
      },
      async () => {
        assert.equal(
          await runCli(["init", "relay.example.com"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );
        assert.equal(
          await runCli(["project", "apply", "one", firstRepoPath, "--issue-prefix", "ONE", "--no-connect"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        const stderr = createBufferStream();
        assert.equal(
          await runCli(["project", "apply", "two", secondRepoPath], {
            stdout: createBufferStream().stream,
            stderr: stderr.stream,
          }),
          1,
        );
        assert.match(stderr.read(), /requires routing/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli project apply can auto-connect using the default service.env file", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-project-apply-connect-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const repoPath = path.join(baseDir, "repo");

  try {
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "IMPLEMENTATION_WORKFLOW.md"), "# implementation\n", "utf8");
    writeFileSync(path.join(repoPath, "REVIEW_WORKFLOW.md"), "# review\n", "utf8");
    writeFileSync(path.join(repoPath, "DEPLOY_WORKFLOW.md"), "# deploy\n", "utf8");
    writeFileSync(path.join(repoPath, "CLEANUP_WORKFLOW.md"), "# cleanup\n", "utf8");

    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
        LINEAR_WEBHOOK_SECRET: undefined,
        PATCHRELAY_TOKEN_ENCRYPTION_KEY: undefined,
        LINEAR_OAUTH_CLIENT_ID: undefined,
        LINEAR_OAUTH_CLIENT_SECRET: undefined,
      },
      async () => {
        assert.equal(
          await runCli(["init", "relay.example.com"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        const envPath = path.join(configHome, "patchrelay", "service.env");
        writeFileSync(
          envPath,
          [
            "LINEAR_WEBHOOK_SECRET=secret",
            "PATCHRELAY_TOKEN_ENCRYPTION_KEY=enc-secret",
            "LINEAR_OAUTH_CLIENT_ID=client-id",
            "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
            "",
          ].join("\n"),
          "utf8",
        );

        const connectData = {
          async connect(projectId?: string) {
            return {
              completed: true as const,
              reusedExisting: true as const,
              projectId: projectId ?? "usertold",
              installation: { id: 7, workspaceName: "Workspace Seven" },
            };
          },
        } as unknown as CliDataAccess;

        const projectOut = createBufferStream();
        const commands: string[] = [];
        assert.equal(
          await runCli(["project", "apply", "usertold", repoPath, "--issue-prefix", "USE"], {
            stdout: projectOut.stream,
            stderr: createBufferStream().stream,
            data: connectData,
            runInteractive: async (command, args) => {
              commands.push([command, ...args].join(" "));
              return 0;
            },
          }),
          0,
        );
        assert.match(projectOut.read(), /Created project usertold/);
        assert.match(projectOut.read(), /Linked project usertold to existing Linear installation 7/);
        assert.deepEqual(commands, [
          "systemctl --user daemon-reload",
          "systemctl --user enable --now patchrelay.path",
          "systemctl --user enable patchrelay.service",
          "systemctl --user reload-or-restart patchrelay.service",
        ]);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli project apply json performs the workflow and returns structured connect state", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-project-apply-json-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const repoPath = path.join(baseDir, "repo");

  try {
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(path.join(repoPath, "IMPLEMENTATION_WORKFLOW.md"), "# implementation\n", "utf8");
    writeFileSync(path.join(repoPath, "REVIEW_WORKFLOW.md"), "# review\n", "utf8");
    writeFileSync(path.join(repoPath, "DEPLOY_WORKFLOW.md"), "# deploy\n", "utf8");
    writeFileSync(path.join(repoPath, "CLEANUP_WORKFLOW.md"), "# cleanup\n", "utf8");

    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_CONFIG: undefined,
        PATCHRELAY_DB_PATH: undefined,
        PATCHRELAY_LOG_FILE: undefined,
        LINEAR_WEBHOOK_SECRET: undefined,
        PATCHRELAY_TOKEN_ENCRYPTION_KEY: undefined,
        LINEAR_OAUTH_CLIENT_ID: undefined,
        LINEAR_OAUTH_CLIENT_SECRET: undefined,
      },
      async () => {
        assert.equal(
          await runCli(["init", "relay.example.com"], {
            stdout: createBufferStream().stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );

        writeFileSync(
          path.join(configHome, "patchrelay", "service.env"),
          [
            "LINEAR_WEBHOOK_SECRET=secret",
            "PATCHRELAY_TOKEN_ENCRYPTION_KEY=enc-secret",
            "LINEAR_OAUTH_CLIENT_ID=client-id",
            "LINEAR_OAUTH_CLIENT_SECRET=client-secret",
            "",
          ].join("\n"),
          "utf8",
        );

        const connectData = {
          async connect(projectId?: string) {
            return {
              completed: true as const,
              reusedExisting: true as const,
              projectId: projectId ?? "usertold",
              installation: { id: 9, workspaceName: "Workspace Nine" },
            };
          },
        } as unknown as CliDataAccess;

        const projectOut = createBufferStream();
        assert.equal(
          await runCli(["project", "apply", "usertold", repoPath, "--issue-prefix", "USE", "--json"], {
            stdout: projectOut.stream,
            stderr: createBufferStream().stream,
            data: connectData,
            runInteractive: async () => 0,
          }),
          0,
        );

        const parsed = JSON.parse(projectOut.read()) as Record<string, unknown>;
        assert.equal(parsed.status, "created");
        assert.equal((parsed.serviceReloaded as boolean | undefined) ?? false, true);
        assert.equal(((parsed.readiness as { ok?: boolean }).ok ?? false), true);
        assert.deepEqual(parsed.connect, {
          attempted: true,
          result: {
            completed: true,
            reusedExisting: true,
            projectId: "usertold",
            installation: { id: 9, workspaceName: "Workspace Nine" },
          },
        });
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli connect and installations cover OAuth installation flows", async () => {
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
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli connect reuses an existing installation when the project can be linked locally", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-connect-reuse-"));
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
          completed: true as const,
          reusedExisting: true as const,
          projectId: projectId ?? "usertold",
          installation: { id: 7, workspaceName: "Workspace Seven" },
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
      }),
      0,
    );
    assert.match(connectOut.read(), /Linked project usertold to existing Linear installation 7/);
    assert.match(connectOut.read(), /No new OAuth approval was needed/);
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

  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli installation commands use the local HTTP service end to end", async (t) => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-http-"));
  try {
    const config = {
      ...createConfig(baseDir),
      server: {
        ...createConfig(baseDir).server,
        publicBaseUrl: "https://patchrelay.example.com",
      },
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
          if (oauthPollCount < 2) {
            return { state, status: "pending" as const, projectId: "usertold" };
          }
          links.set("usertold", 7);
          return {
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
      } as never,
      pino({ enabled: false }),
    );

    try {
      await app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EPERM") {
        t.skip("Binding a local TCP listener is not permitted in this environment");
      }
      throw error;
    }
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

    data.close();
    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
