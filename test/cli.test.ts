import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getBuildInfo } from "../src/build-info.ts";
import pino from "pino";
import { runCli } from "../src/cli/index.ts";
import { loadConfig } from "../src/config.ts";
import { CliDataAccess } from "../src/cli/data.ts";
import { PatchRelayDatabase } from "../src/db.ts";
import { buildHttpServer } from "../src/http.ts";
import type { AppConfig, CodexThreadSummary } from "../src/types.ts";



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
      githubWebhookPath: "/webhooks/github",
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

function runCliProcess(
  args: string[],
  options?: { env?: Record<string, string | undefined>; cwd?: string },
) {
  const env = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return spawnSync(process.execPath, ["--experimental-transform-types", "src/index.ts", ...args], {
    cwd: options?.cwd ?? process.cwd(),
    encoding: "utf8",
    env,
  });
}

async function runCliProcessAsync(
  args: string[],
  options?: { env?: Record<string, string | undefined>; cwd?: string },
): Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const env = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-transform-types", "src/index.ts", ...args], {
      cwd: options?.cwd ?? process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
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

function writeRunnerBinaries(configPath: string, binaries: { gitBin?: string; codexBin?: string }): void {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    runner?: {
      git_bin?: string;
      codex?: {
        bin?: string;
      };
    };
  };

  raw.runner ??= {};
  if (binaries.gitBin) {
    raw.runner.git_bin = binaries.gitBin;
  }
  if (binaries.codexBin) {
    raw.runner.codex ??= {};
    raw.runner.codex.bin = binaries.codexBin;
  }

  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function createStubCodex(
  threads: Record<string, CodexThreadSummary>,
  options?: { startThreadId?: string },
) {
  return {
    async start() {},
    async stop() {},
    async readThread(threadId: string) {
      const thread = threads[threadId];
      if (!thread) {
        throw new Error(`Missing thread ${threadId}`);
      }
      return thread;
    },
    async startThread(params: { cwd: string }) {
      const id = options?.startThreadId ?? `thread-created-${Object.keys(threads).length + 1}`;
      const thread: CodexThreadSummary = {
        id,
        preview: "Operator session",
        cwd: params.cwd,
        status: "running",
        turns: [],
      };
      threads[id] = thread;
      return thread;
    },
  };
}

function seedDatabase(db: PatchRelayDatabase, config: AppConfig): void {
  mkdirSync(config.projects[0].worktreeRoot, { recursive: true });

  // Issue 1: USE-54 — failed deploy with a completed run
  const issue1 = db.upsertIssue({
    projectId: "usertold",
    linearIssueId: "issue-1",
    issueKey: "USE-54",
    title: "Playback-first evidence workspace",
    url: "https://linear.example/USE-54",
    currentLinearState: "Human Needed",
    pendingRunType: "implementation",
    branchName: "use/USE-54-playback-first-evidence-workspace",
    worktreePath: path.join(config.projects[0].worktreeRoot, "USE-54"),
    threadId: "thread-54",
    factoryState: "failed",
  });
  const completedRun = db.createRun({
    issueId: issue1.id,
    projectId: "usertold",
    linearIssueId: "issue-1",
    runType: "implementation",
    
    promptText: "Deploy it",
  });
  mkdirSync(path.join(config.projects[0].worktreeRoot, "USE-54"), { recursive: true });
  db.updateRunThread(completedRun.id, { threadId: "thread-54", turnId: "turn-54" });
  db.saveThreadEvent({
    runId: completedRun.id,
    threadId: "thread-54",
    turnId: "turn-54",
    method: "turn/started",
    eventJson: JSON.stringify({ threadId: "thread-54", turnId: "turn-54" }),
  });
  db.finishRun(completedRun.id, {
    status: "failed",
    threadId: "thread-54",
    turnId: "turn-54",
    summaryJson: JSON.stringify({
      latestAssistantMessage: "Deploy did not complete because auth was missing.",
    }),
    reportJson: JSON.stringify({
      issueKey: "USE-54",
      runType: "implementation",
      status: "failed",
      threadId: "thread-54",
      turnId: "turn-54",
      prompt: "Deploy it",
      
      assistantMessages: ["Deploy did not complete because auth was missing."],
      plans: [],
      reasoning: [],
      commands: [{ command: "npm run deploy", cwd: "/tmp/use-54", status: "failed", exitCode: 1 }],
      fileChanges: [{ path: "src/session-detail.tsx", kind: "update" }],
      toolCalls: [{ type: "dynamic", name: "apply_patch", status: "completed" }],
      eventCounts: { "turn/started": 1 },
    }),
  });

  // Issue 2: USE-55 — idle review issue, no desired stage
  db.upsertIssue({
    projectId: "usertold",
    linearIssueId: "issue-2",
    issueKey: "USE-55",
    title: "Queued review issue",
    currentLinearState: "Review",
    factoryState: "delegated",
  });

  // Issue 3: USE-56 — running development stage with an active run
  const issue3 = db.upsertIssue({
    projectId: "usertold",
    linearIssueId: "issue-3",
    issueKey: "USE-56",
    title: "Running stage",
    currentLinearState: "Start",
    pendingRunType: "implementation",
    branchName: "use/USE-56-running-stage",
    worktreePath: path.join(config.projects[0].worktreeRoot, "USE-56"),
    factoryState: "implementing",
  });
  const runningRun = db.createRun({
    issueId: issue3.id,
    projectId: "usertold",
    linearIssueId: "issue-3",
    runType: "implementation",
    
    promptText: "Build it",
  });
  mkdirSync(path.join(config.projects[0].worktreeRoot, "USE-56"), { recursive: true });
  db.updateRunThread(runningRun.id, { threadId: "thread-56", turnId: "turn-56" });
  db.upsertIssue({
    projectId: "usertold",
    linearIssueId: "issue-3",
    activeRunId: runningRun.id,
  });
}

function seedRuntimeFiles(config: AppConfig): void {
  mkdirSync(config.projects[0].repoPath, { recursive: true });
  for (const workflow of config.projects[0].workflows) {
    writeFileSync(workflow.workflowFile, "# workflow\n", "utf8");
  }
}

test("cli inspect, worktree, open, events, and report render stored issue details", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({
        "thread-54": {
          id: "thread-54",
          preview: "Deploy issue",
          cwd: path.join(config.projects[0].worktreeRoot, "USE-54"),
          status: "completed",
          turns: [],
        },
      }) as never,
    });

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
    assert.match(openOut.read(), /codex --dangerously-bypass-approvals-and-sandbox resume -C .*USE-54 thread-54/);

    const reportOut = createBufferStream();
    assert.equal(await runCli(["report", "USE-54"], { config, data, stdout: reportOut.stream, stderr: stderr.stream }), 0);
    assert.match(reportOut.read(), /deploy #1 failed/);
    assert.match(reportOut.read(), /npm run deploy/);

    const eventsOut = createBufferStream();
    assert.equal(await runCli(["events", "USE-54"], { config, data, stdout: eventsOut.stream, stderr: stderr.stream }), 0);
    assert.match(eventsOut.read(), /turn\/started/);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli open launches codex in the issue worktree", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({
        "thread-54": {
          id: "thread-54",
          preview: "Deploy issue",
          cwd: path.join(config.projects[0].worktreeRoot, "USE-54"),
          status: "completed",
          turns: [],
        },
      }) as never,
    });

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
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli open resumes the thread stored on the issue record", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-open-session-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);

    // Set a threadId directly on the issue (the new model stores it on issues)
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      threadId: "thread-newer",
    });

    const workspace = db.getWorkspaceForIssue("usertold", "issue-1");
    assert.ok(workspace);

    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({
        "thread-newer": {
          id: "thread-newer",
          preview: "Reopened issue session",
          cwd: workspace.worktreePath,
          status: "running",
          turns: [],
        },
      }) as never,
    });

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
    assert.deepEqual(calls.at(0)?.args, [
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "-C",
      workspace.worktreePath,
      "thread-newer",
    ]);
    // Verify the threadId is still stored on the issue
    const updated = db.getIssue("usertold", "issue-1");
    assert.equal(updated?.threadId, "thread-newer");
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli open creates a fresh thread when the stored threadId cannot be resumed", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-open-fresh-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);

    // Set a threadId that the stub codex will not recognise (simulates stale thread)
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      threadId: "thread-missing",
    });

    const workspace = db.getWorkspaceForIssue("usertold", "issue-1");
    assert.ok(workspace);

    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({}, { startThreadId: "thread-created-1" }) as never,
    });

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
    assert.deepEqual(calls.at(0)?.args, [
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "-C",
      workspace.worktreePath,
      "thread-created-1",
    ]);

    // Verify the new threadId was persisted on the issue
    const updated = db.getIssue("usertold", "issue-1");
    assert.equal(updated?.threadId, "thread-created-1");
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli open --print does not advertise a stale resume thread", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-open-print-fresh-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);

    // Set a threadId that the stub codex will not recognise (stale)
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      threadId: "thread-missing",
    });

    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({}) as never,
    });

    const stdout = createBufferStream();
    const exitCode = await runCli(["open", "USE-54", "--print"], {
      config,
      data,
      stdout: stdout.stream,
      stderr: createBufferStream().stream,
    });

    assert.equal(exitCode, 0);
    assert.doesNotMatch(stdout.read(), /resume thread-missing/);
    assert.match(stdout.read(), /create a fresh session/);
    assert.match(stdout.read(), /codex --dangerously-bypass-approvals-and-sandbox -C /);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli list and retry cover operator control flows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    data = new CliDataAccess(config, { db });

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
    const updatedIssue = db.getIssue("usertold", "issue-2");
    assert.equal(updatedIssue?.desiredStage, "review");

    const inspectJson = createBufferStream();
    assert.equal(await runCli(["USE-54", "--json"], { config, data, stdout: inspectJson.stream, stderr: createBufferStream().stream }), 0);
    assert.match(inspectJson.read(), /"issueKey": "USE-54"/);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli rejects unknown commands, unknown flags, and invalid numeric flags", async () => {
  const commandError = createBufferStream();
  assert.equal(await runCli(["conenct"], { stdout: createBufferStream().stream, stderr: commandError.stream }), 1);
  assert.match(commandError.read(), /PatchRelay/);
  assert.match(commandError.read(), /Error: Unknown command: conenct/);

  const flagError = createBufferStream();
  assert.equal(
    await runCli(["connect", "--projct", "usertold"], {
      stdout: createBufferStream().stream,
      stderr: flagError.stream,
    }),
    1,
  );
  assert.match(flagError.read(), /PatchRelay/);
  assert.match(flagError.read(), /Error: Unknown flag: --projct/);

  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-invalid-stage-run-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    data = new CliDataAccess(config, { db });

    const stageRunError = createBufferStream();
    assert.equal(
      await runCli(["report", "USE-54", "--stage-run", "abc"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: stageRunError.stream,
      }),
      1,
    );
    assert.match(stageRunError.read(), /--stage-run must be a positive integer/);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli retry blocks when the issue still has an active run", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-retry-ledger-active-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);
    data = new CliDataAccess(config, { db });

    // Create an active run on issue-2 and point the issue's activeRunId at it
    const issue = db.getIssue("usertold", "issue-2");
    assert.ok(issue);
    const run = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.updateRunThread(run.id, { threadId: "thread-55-active" });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      branchName: "use/USE-55-ledger-active",
      worktreePath: path.join(config.projects[0].worktreeRoot, "USE-55-ledger-active"),
      activeRunId: run.id,
      factoryState: "implementing",
    });

    assert.throws(() => data!.retry("USE-55"), /already has an active stage run/);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli resolves workspace, run context, and live summary from the unified issue+runs model", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-unified-model-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedRuntimeFiles(config);

    // Create issue-4 with a stale completed run, then an active development run
    const issue4 = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-4",
      issueKey: "USE-57",
      title: "Ledger-backed running issue",
      currentLinearState: "Implementing",
      branchName: "use/USE-57-ledger-backed-running-issue",
      worktreePath: path.join(config.projects[0].worktreeRoot, "USE-57"),
      factoryState: "implementing",
    });

    // First run: completed stale review
    const staleRun = db.createRun({
      issueId: issue4.id,
      projectId: "usertold",
      linearIssueId: "issue-4",
      runType: "implementation",
      
      promptText: "Stale review run",
    });
    db.updateRunThread(staleRun.id, { threadId: "thread-57-stale", turnId: "turn-57-stale" });
    db.finishRun(staleRun.id, {
      status: "completed",
      threadId: "thread-57-stale",
      turnId: "turn-57-stale",
    });

    // Second run: active development run
    const activeRun = db.createRun({
      issueId: issue4.id,
      projectId: "usertold",
      linearIssueId: "issue-4",
      runType: "implementation",
    });
    db.updateRunThread(activeRun.id, { threadId: "thread-57", turnId: "turn-57" });
    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-4",
      activeRunId: activeRun.id,
      threadId: "thread-57",
    });

    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({
        "thread-57": {
          id: "thread-57",
          preview: "Ledger-backed running issue",
          cwd: path.join(config.projects[0].worktreeRoot, "USE-57"),
          status: "running",
          turns: [
            {
              id: "turn-57",
              status: "inProgress",
              items: [{ type: "agentMessage", id: "assistant-57", text: "Still implementing the change." }],
            },
          ],
        },
      }) as never,
    });
    const worktree = data.worktree("USE-57");
    assert.equal(worktree?.workspace.worktreePath, path.join(config.projects[0].worktreeRoot, "USE-57"));

    const opened = data.open("USE-57");
    assert.equal(opened?.resumeThreadId, "thread-57");

    const inspect = await data.inspect("USE-57");
    assert.equal(inspect?.activeStageRun?.stage, "development");
    assert.equal(inspect?.activeStageRun?.threadId, "thread-57");
    assert.equal(inspect?.latestStageRun?.stage, "development");

    const live = await data.live("USE-57");
    assert.equal(live?.stageRun.stage, "development");
    assert.equal(live?.stageRun.threadId, "thread-57");
    assert.equal(live?.live?.latestTurnStatus, "inProgress");

    const list = data.list({ active: true });
    const listed = list.find((entry) => entry.issueKey === "USE-57");
    assert.equal(listed?.activeStage, "development");
    assert.equal(listed?.latestStage, "development");
    assert.equal(listed?.latestStageStatus, "running");
  } finally {
    data?.close();
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
    assert.match(stdout.read(), /FAIL \[project:usertold:workflow:(default:)?development\]/);
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
  assert.match(stdout.read(), /version \[--json\]/);
  assert.match(stdout.read(), /patchrelay init <public-https-url>/);
  assert.match(stdout.read(), /patchrelay project apply <id> <repo-path>/);
  assert.match(stdout.read(), /Automation env vars:/);
  assert.match(stdout.read(), /Examples:/);
  assert.match(
    stdout.read(),
    /In the normal\s+case you only need the public URL, the required secrets, and at least one project\./,
  );
});

test("cli project help prints command-specific usage and errors", async () => {
  const helpOut = createBufferStream();
  assert.equal(await runCli(["project", "--help"], { stdout: helpOut.stream, stderr: createBufferStream().stream }), 0);
  assert.match(helpOut.read(), /patchrelay project apply <id> <repo-path>/);
  assert.match(helpOut.read(), /Behavior:/);

  const usageError = createBufferStream();
  assert.equal(await runCli(["project"], { stdout: createBufferStream().stream, stderr: usageError.stream }), 1);
  assert.match(usageError.read(), /patchrelay project apply <id> <repo-path>/);
  assert.match(usageError.read(), /Error: patchrelay project requires a subcommand\./);

  const flagError = createBufferStream();
  assert.equal(
    await runCli(["project", "apply", "demo", "/tmp/demo", "--bogus"], {
      stdout: createBufferStream().stream,
      stderr: flagError.stream,
    }),
    1,
  );
  assert.match(flagError.read(), /patchrelay project apply <id> <repo-path>/);
  assert.match(flagError.read(), /Error: Unknown flag: --bogus/);
});

test("cli process paths avoid sqlite warnings until sqlite-backed commands run", () => {
  const help = runCliProcess(["help"]);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stderr, /SQLite is an experimental feature/);

  const version = runCliProcess(["version"]);
  assert.equal(version.status, 0);
  assert.doesNotMatch(version.stderr, /SQLite is an experimental feature/);

  const unknown = runCliProcess(["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Error: Unknown command: frobnicate/);
  assert.doesNotMatch(unknown.stderr, /SQLite is an experimental feature/);
});

test("cli feed uses the HTTP operator client without loading sqlite", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-feed-http-only-"));
  const configDir = path.join(baseDir, "config");
  const configPath = path.join(configDir, "patchrelay.json");
  mkdirSync(configDir, { recursive: true });

  const server = createServer((request, response) => {
    assert.equal(request.url, "/api/feed?limit=1&kind=workflow&stage=development&status=transition_chosen&workflow=default");
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "close",
    });
    response.end(
      JSON.stringify({
        ok: true,
        events: [
          {
            id: 1,
            at: "2026-03-13T18:00:00.000Z",
            level: "info",
            kind: "workflow",
            issueKey: "USE-1",
            projectId: "usertold",
            runType: "implementation",
            workflowId: "default",
            nextStage: "review",
            status: "transition_chosen",
            summary: "Chose development -> review",
          },
        ],
      }),
    );
  });

  try {
    const address = await new Promise<{ port: number }>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const value = server.address();
        if (!value || typeof value === "string") {
          reject(new Error("Expected a TCP address"));
          return;
        }
        resolve({ port: value.port });
      });
      server.once("error", reject);
    });

    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          server: {
            bind: "127.0.0.1",
            port: address.port,
          },
          ingress: {
            linear_webhook_path: "/webhooks/linear",
            max_body_bytes: 262144,
            max_timestamp_skew_seconds: 60,
          },
          logging: {
            file_path: path.join(baseDir, "patchrelay.log"),
          },
          database: {
            path: path.join(baseDir, "patchrelay.sqlite"),
          },
          operator_api: {
            enabled: true,
          },
          linear: {
            webhook_secret_env: "LINEAR_WEBHOOK_SECRET",
            token_encryption_key_env: "PATCHRELAY_TOKEN_ENCRYPTION_KEY",
            oauth: {
              client_id_env: "LINEAR_OAUTH_CLIENT_ID",
              client_secret_env: "LINEAR_OAUTH_CLIENT_SECRET",
              redirect_uri: `http://127.0.0.1:${address.port}/oauth/linear/callback`,
              scopes: ["read", "write"],
              actor: "user",
            },
          },
          runner: {
            git_bin: "git",
            codex: {
              bin: "codex",
              args: ["app-server"],
              approval_policy: "never",
              sandbox_mode: "danger-full-access",
              persist_extended_history: false,
            },
          },
          projects: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = await runCliProcessAsync(
      ["feed", "--json", "--limit", "1", "--kind", "workflow", "--stage", "development", "--status", "transition_chosen", "--workflow", "default"],
      {
        env: {
          PATCHRELAY_CONFIG: configPath,
          LINEAR_WEBHOOK_SECRET: "webhook-secret",
          PATCHRELAY_TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
          LINEAR_OAUTH_CLIENT_ID: "oauth-client-id",
          LINEAR_OAUTH_CLIENT_SECRET: "oauth-client-secret",
        },
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /"events":/);
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli version prints the installed build version in text and json", async () => {
  const buildInfo = getBuildInfo();

  const stdout = createBufferStream();
  assert.equal(await runCli(["version"], { stdout: stdout.stream, stderr: createBufferStream().stream }), 0);
  assert.equal(stdout.read().trim(), buildInfo.version);

  const jsonOut = createBufferStream();
  assert.equal(await runCli(["version", "--json"], { stdout: jsonOut.stream, stderr: createBufferStream().stream }), 0);
  assert.match(jsonOut.read(), new RegExp(`"version":\\s*"${buildInfo.version.replaceAll(".", "\\.")}"`));
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
        const repoSettingsPath = path.join(repoPath, ".patchrelay", "project.json");
        const configContents = readFileSync(configPath, "utf8");
        assert.match(configContents, /"projects"\s*:/);
        assert.match(configContents, /"id"\s*:\s*"usertold"/);
        assert.match(configContents, /"repo_path"\s*:/);
        assert.match(configContents, /"issue_key_prefixes"\s*:/);
        assert.equal(existsSync(repoSettingsPath), true);
        assert.match(readFileSync(repoSettingsPath, "utf8"), /"workflow_definitions"\s*:/);

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
        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
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
        writeRunnerBinaries(configPath, { codexBin: "true" });

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
        writeRunnerBinaries(path.join(configHome, "patchrelay", "patchrelay.json"), { codexBin: "true" });

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

test("cli feed renders operator observations in text and json", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-feed-"));
  try {
    const config = createConfig(baseDir);
    const data = {
      async listOperatorFeed() {
        return {
          events: [
            {
              id: 1,
              at: "2026-03-13T12:34:56.000Z",
              level: "info" as const,
              kind: "workflow" as const,
              issueKey: "USE-54",
              runType: "implementation" as const,
              workflowId: "default",
              nextStage: "review" as const,
              status: "transition_chosen",
              summary: "Chose development -> review",
              detail: "Turn turn-54 is now live.",
            },
          ],
        };
      },
    } as unknown as CliDataAccess;

    const textOut = createBufferStream();
    assert.equal(
      await runCli(["feed"], {
        config,
        data,
        stdout: textOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(textOut.read(), /USE-54/);
    assert.match(textOut.read(), /Chose development -> review/);
    assert.match(textOut.read(), /workflow:default/);

    const jsonOut = createBufferStream();
    assert.equal(
      await runCli(["feed", "--json"], {
        config,
        data,
        stdout: jsonOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(JSON.parse(jsonOut.read()), {
      events: [
        {
          id: 1,
          at: "2026-03-13T12:34:56.000Z",
          level: "info",
          kind: "workflow",
          issueKey: "USE-54",
          runType: "implementation",
          workflowId: "default",
          nextStage: "review",
          status: "transition_chosen",
          summary: "Chose development -> review",
          detail: "Turn turn-54 is now live.",
        },
      ],
    });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli feed forwards issue and project filters to the operator API client", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-feed-filters-"));
  try {
    const config = createConfig(baseDir);
    const seen: Array<Record<string, unknown>> = [];
    const data = {
      async listOperatorFeed(options?: {
        limit?: number;
        issueKey?: string;
        projectId?: string;
        kind?: string;
        stage?: string;
        status?: string;
        workflowId?: string;
      }) {
        seen.push(options ?? {});
        return { events: [] };
      },
      async followOperatorFeed(
        _onEvent: (event: Record<string, unknown>) => void,
        options?: {
          limit?: number;
          issueKey?: string;
          projectId?: string;
          kind?: string;
          stage?: string;
          status?: string;
          workflowId?: string;
        },
      ) {
        seen.push(options ?? {});
      },
    } as unknown as CliDataAccess;

    assert.equal(
      await runCli(["feed", "--issue", "USE-54", "--project", "usertold", "--limit", "25"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(seen[0], { limit: 25, issueKey: "USE-54", projectId: "usertold" });

    assert.equal(
      await runCli(["feed", "--kind", "workflow", "--stage", "development", "--status", "transition_chosen", "--workflow", "default"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(seen[1], {
      limit: 50,
      kind: "workflow",
      runType: "implementation",
      status: "transition_chosen",
      workflowId: "default",
    });

    assert.equal(
      await runCli(["feed", "--follow", "--issue", "USE-54", "--project", "usertold"], {
        config,
        data,
        stdout: createBufferStream().stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.deepEqual(seen[2], { limit: 50, issueKey: "USE-54", projectId: "usertold" });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli feed --follow streams live operator observations", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-feed-follow-"));
  try {
    const config = createConfig(baseDir);
    const data = {
      async followOperatorFeed(onEvent: (event: Record<string, unknown>) => void) {
        onEvent({
          id: 7,
          at: "2026-03-13T12:35:10.000Z",
          level: "info",
          kind: "agent",
          issueKey: "USE-54",
          status: "delegated",
          summary: "Delegated to PatchRelay",
        });
      },
    } as unknown as CliDataAccess;

    const stdout = createBufferStream();
    assert.equal(
      await runCli(["feed", "--follow"], {
        config,
        data,
        stdout: stdout.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(stdout.read(), /Delegated to PatchRelay/);
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
