import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
      port: 19787,
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
    repos: {
      root: path.join(baseDir, "repos"),
    },
    repositories: [
      {
        githubRepo: "krasnoperov/usertold",
        localPath: path.join(baseDir, "repo"),
        workspace: "usertold",
        linearTeamIds: ["USE"],
        linearProjectIds: [],
        issueKeyPrefixes: ["USE"],
      },
    ],
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
    secretSources: {},
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

async function _runCliProcessAsync(
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

function setReposRoot(configPath: string, reposRoot: string): void {
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
    repos?: {
      root?: string;
    };
  };
  raw.repos ??= {};
  raw.repos.root = reposRoot;
  writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

function initializeGitRepo(repoPath: string, githubRepo: string): void {
  mkdirSync(repoPath, { recursive: true });
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  const remote = spawnSync("git", ["-C", repoPath, "remote", "add", "origin", `https://github.com/${githubRepo}.git`], { encoding: "utf8" });
  assert.equal(remote.status, 0, remote.stderr);
}

function writeExternalConfig(configPath: string, baseDir: string, overrides?: {
  serverPort?: number;
  publicBaseUrl?: string;
  redirectUri?: string;
}): void {
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        server: {
          bind: "127.0.0.1",
          port: overrides?.serverPort ?? 19787,
          public_base_url: overrides?.publicBaseUrl ?? "https://patchrelay.example.com",
          health_path: "/health",
          readiness_path: "/ready",
        },
        ingress: {
          linear_webhook_path: "/webhooks/linear",
          github_webhook_path: "/webhooks/github",
          max_body_bytes: 262144,
          max_timestamp_skew_seconds: 60,
        },
        logging: {
          level: "info",
          format: "logfmt",
          file_path: path.join(baseDir, "patchrelay.log"),
        },
        database: {
          path: path.join(baseDir, "patchrelay.sqlite"),
          wal: true,
        },
        operator_api: {
          enabled: true,
        },
        linear: {
          webhook_secret: "webhook-secret",
          graphql_url: "https://linear.example/graphql",
          oauth: {
            client_id: "client-id",
            client_secret: "client-secret",
            redirect_uri: overrides?.redirectUri ?? "http://127.0.0.1:8787/oauth/linear/callback",
            scopes: ["read", "write"],
            actor: "app",
          },
          token_encryption_key: "0123456789abcdef0123456789abcdef",
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
        repos: {
          root: path.join(baseDir, "projects"),
        },
        repositories: [],
        projects: [],
        secretSources: {},
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
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
  for (const workflow of []) {
    writeFileSync(workflow.workflowFile, "# workflow\n", "utf8");
  }
}

test("cli inspect, worktree, and open render stored issue details", async () => {
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
    assert.equal(await runCli(["issue", "show", "USE-54"], { config, data, stdout: stdout.stream, stderr: stderr.stream }), 0);
    assert.match(stdout.read(), /USE-54 {2}Human Needed/);
    assert.match(stdout.read(), /Debug stage: failed/);
    assert.match(stdout.read(), /Deploy did not complete because auth was missing/);

    const worktreeOut = createBufferStream();
    assert.equal(await runCli(["issue", "path", "USE-54", "--cd"], { config, data, stdout: worktreeOut.stream, stderr: stderr.stream }), 0);
    assert.equal(worktreeOut.read().trim(), path.join(config.projects[0].worktreeRoot, "USE-54"));

    const openOut = createBufferStream();
    assert.equal(await runCli(["issue", "open", "USE-54", "--print"], { config, data, stdout: openOut.stream, stderr: stderr.stream }), 0);
    assert.match(openOut.read(), /codex --dangerously-bypass-approvals-and-sandbox resume -C .*USE-54 thread-54/);

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
    const exitCode = await runCli(["issue", "open", "USE-54"], {
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

    const workspace = db.getIssue("usertold", "issue-1");
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
    const exitCode = await runCli(["issue", "open", "USE-54"], {
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

    const workspace = db.getIssue("usertold", "issue-1");
    assert.ok(workspace);

    data = new CliDataAccess(config, {
      db,
      codex: createStubCodex({}, { startThreadId: "thread-created-1" }) as never,
    });

    const calls: Array<{ command: string; args: string[] }> = [];
    const exitCode = await runCli(["issue", "open", "USE-54"], {
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
    const exitCode = await runCli(["issue", "open", "USE-54", "--print"], {
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
    const doneIssue = db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-done",
      issueKey: "USE-57",
      title: "Merged despite an earlier failed run",
      currentLinearState: "Done",
      factoryState: "done",
    });
    const doneRun = db.createRun({
      issueId: doneIssue.id,
      projectId: doneIssue.projectId,
      linearIssueId: doneIssue.linearIssueId,
      runType: "implementation",
      promptText: "Earlier failed attempt",
    });
    db.finishRun(doneRun.id, { status: "failed", failureReason: "old failure" });
    data = new CliDataAccess(config, { db });

    const failedList = createBufferStream();
    assert.equal(await runCli(["issue", "list", "--failed"], { config, data, stdout: failedList.stream, stderr: createBufferStream().stream }), 0);
    assert.match(failedList.read(), /USE-54/);
    assert.doesNotMatch(failedList.read(), /USE-55/);
    assert.doesNotMatch(failedList.read(), /USE-57/);

    const retryOut = createBufferStream();
    assert.equal(
      await runCli(["issue", "retry", "USE-55", "--reason", "operator retry"], {
        config,
        data,
        stdout: retryOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(retryOut.read(), /Queued stage: implementation/);

    const updated = db.getTrackedIssue("usertold", "issue-2");
    assert.equal(updated?.factoryState, "delegated");
    const updatedIssue = db.getIssue("usertold", "issue-2");
    const updatedWake = db.peekIssueSessionWake("usertold", "issue-2");
    assert.equal(updatedIssue?.pendingRunType, undefined);
    assert.equal(updatedWake?.runType, "implementation");

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-queue-repair",
      issueKey: "USE-58",
      title: "Queue-evicted issue",
      currentLinearState: "In Review",
      factoryState: "failed",
      prNumber: 58,
      prState: "open",
      prReviewState: "approved",
      lastGitHubFailureSource: "queue_eviction",
      lastGitHubFailureHeadSha: "sha-queue",
      lastGitHubFailureCheckName: "merge-steward/queue",
    });

    const queueRetryOut = createBufferStream();
    assert.equal(
      await runCli(["issue", "retry", "USE-58"], {
        config,
        data,
        stdout: queueRetryOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(queueRetryOut.read(), /Queued stage: queue_repair/);

    const queueRepairIssue = db.getIssue("usertold", "issue-queue-repair");
    assert.equal(queueRepairIssue?.factoryState, "repairing_queue");
    const queueRepairWake = db.peekIssueSessionWake("usertold", "issue-queue-repair");
    assert.equal(queueRepairIssue?.pendingRunType, undefined);
    assert.equal(queueRepairWake?.runType, "queue_repair");

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-review-fix",
      issueKey: "USE-59",
      title: "Review changes requested",
      currentLinearState: "In Review",
      factoryState: "changes_requested",
      prNumber: 59,
      prState: "open",
      prReviewState: "changes_requested",
    });

    const reviewRetryOut = createBufferStream();
    assert.equal(
      await runCli(["issue", "retry", "USE-59"], {
        config,
        data,
        stdout: reviewRetryOut.stream,
        stderr: createBufferStream().stream,
      }),
      0,
    );
    assert.match(reviewRetryOut.read(), /Queued stage: review_fix/);

    const reviewFixIssue = db.getIssue("usertold", "issue-review-fix");
    assert.equal(reviewFixIssue?.factoryState, "changes_requested");
    const reviewFixWake = db.peekIssueSessionWake("usertold", "issue-review-fix");
    assert.equal(reviewFixIssue?.pendingRunType, undefined);
    assert.equal(reviewFixWake?.runType, "review_fix");

    const inspectJson = createBufferStream();
    assert.equal(await runCli(["issue", "show", "USE-54", "--json"], { config, data, stdout: inspectJson.stream, stderr: createBufferStream().stream }), 0);
    assert.match(inspectJson.read(), /"issueKey": "USE-54"/);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli sessions shows recorded app-server runs with resume commands", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-sessions-"));
  let data: CliDataAccess | undefined;
  try {
    const config = createConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, true);
    db.runMigrations();
    seedDatabase(db, config);

    const issue = db.getIssue("usertold", "issue-1");
    assert.ok(issue);

    const reviewRun = db.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "review_fix",
      promptText: "Address requested review changes",
    });
    db.updateRunThread(reviewRun.id, {
      threadId: "thread-54-review",
      parentThreadId: "thread-54",
      turnId: "turn-54-review",
    });
    db.saveThreadEvent({
      runId: reviewRun.id,
      threadId: "thread-54-review",
      turnId: "turn-54-review",
      method: "turn/started",
      eventJson: JSON.stringify({ threadId: "thread-54-review", turnId: "turn-54-review" }),
    });
    db.finishRun(reviewRun.id, {
      status: "completed",
      threadId: "thread-54-review",
      turnId: "turn-54-review",
      summaryJson: JSON.stringify({
        latestAssistantMessage: "Applied the requested review changes and pushed an update.",
      }),
    });

    data = new CliDataAccess(config, { db });

    const stdout = createBufferStream();
    const stderr = createBufferStream();
    assert.equal(await runCli(["issue", "sessions", "USE-54"], { config, data, stdout: stdout.stream, stderr: stderr.stream }), 0);

    const rendered = stdout.read();
    assert.match(rendered, /run #\d+  review_fix  completed/);
    assert.match(rendered, /Thread: thread-54-review/);
    assert.match(rendered, /Parent thread: thread-54/);
    assert.match(rendered, /Applied the requested review changes and pushed an update/);
    assert.match(rendered, /Open: codex --dangerously-bypass-approvals-and-sandbox resume -C .*USE-54 thread-54-review/);
    assert.match(rendered, /run #\d+  implementation  failed/);
  } finally {
    data?.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli rejects unknown commands and unknown flags", async () => {
  const commandError = createBufferStream();
  assert.equal(await runCli(["conenct"], { stdout: createBufferStream().stream, stderr: commandError.stream }), 1);
  assert.match(commandError.read(), /PatchRelay/);
  assert.match(commandError.read(), /Error: Unknown command: conenct/);

  const flagError = createBufferStream();
  assert.equal(
    await runCli(["linear", "connect", "--projct"], {
      stdout: createBufferStream().stream,
      stderr: flagError.stream,
    }),
    1,
  );
  assert.match(flagError.read(), /PatchRelay/);
  assert.match(flagError.read(), /Error: Unknown flag: --projct/);

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

    assert.throws(() => data!.retry("USE-55"), /already has an active run/);
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
    assert.equal(worktree?.worktreePath, path.join(config.projects[0].worktreeRoot, "USE-57"));

    const opened = data.open("USE-57");
    assert.equal(opened?.resumeThreadId, "thread-57");

    const inspect = await data.inspect("USE-57");
    assert.equal(inspect?.activeRun?.runType, "implementation");
    assert.equal(inspect?.activeRun?.threadId, "thread-57");

    const live = await data.live("USE-57");
    assert.equal(live?.run.runType, "implementation");
    assert.equal(live?.run.threadId, "thread-57");
    assert.equal(live?.live?.latestTurnStatus, "inProgress");

    const list = data.list({ active: true });
    const listed = list.find((entry) => entry.issueKey === "USE-57");
    assert.equal(listed?.activeRunType, "implementation");
    assert.equal(listed?.latestRunType, "implementation");
    assert.equal(listed?.latestRunStatus, "running");
    assert.equal(listed?.sessionState, "running");
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
    assert.match(stdout.read(), /FAIL \[service\] Service is not reachable/);
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

    // Service readiness check fails in tests (no running service), but other checks pass.
    assert.equal(exitCode, 1);
    const text = stdout.read();
    assert.match(text, /FAIL \[service\] Service is not reachable/);
    assert.match(text, /PASS \[database\]/);
    assert.match(text, /PASS \[git\]/);

    const jsonOut = createBufferStream();
    assert.equal(await runCli(["doctor", "--json"], { config, stdout: jsonOut.stream, stderr: stderr.stream }), 1);
    assert.match(jsonOut.read(), /"ok": false/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli help explains the setup sequence and default behavior", async () => {
  const stdout = createBufferStream();
  const stderr = createBufferStream();

  assert.equal(await runCli([], { stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stderr.read(), "");
  assert.match(stdout.read(), /Happy path:/);
  assert.match(stdout.read(), /patchrelay version --json/);
  assert.match(stdout.read(), /patchrelay init <public-https-url>/);
  assert.match(stdout.read(), /patchrelay linear connect/);
  assert.match(stdout.read(), /patchrelay repo link krasnoperov\/usertold --workspace usertold --team USE/);
  assert.match(stdout.read(), /dashboard \[--issue <issueKey>\]/);
  assert.match(stdout.read(), /service status \[--json\]/);
  assert.match(stdout.read(), /issue watch <issueKey>/);
  assert.match(stdout.read(), /Automation env vars:/);
  assert.match(stdout.read(), /Examples:/);
  assert.match(stdout.read(), /Mental model:/);
});

test("cli linear and repo help print command-specific usage and legacy aliases point to replacements", async () => {
  const linearHelp = createBufferStream();
  assert.equal(await runCli(["linear", "--help"], { stdout: linearHelp.stream, stderr: createBufferStream().stream }), 0);
  assert.match(linearHelp.read(), /patchrelay linear connect/);
  assert.match(linearHelp.read(), /authorizes one Linear workspace/);
  assert.match(linearHelp.read(), /patchrelay connect/);

  const repoHelp = createBufferStream();
  assert.equal(await runCli(["repo", "--help"], { stdout: repoHelp.stream, stderr: createBufferStream().stream }), 0);
  assert.match(repoHelp.read(), /patchrelay repo link <github-repo>/);
  assert.match(repoHelp.read(), /GitHub repo as the source of truth/);
  assert.match(repoHelp.read(), /patchrelay attach/);
  assert.match(repoHelp.read(), /patchrelay repos/);

  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-aliases-"));
  try {
    const config = createConfig(baseDir);

    const reposOut = createBufferStream();
    assert.equal(await runCli(["repos"], { stdout: reposOut.stream, stderr: createBufferStream().stream, config }), 0);
    assert.match(reposOut.read(), /krasnoperov\/usertold/);

    const reposShowOut = createBufferStream();
    assert.equal(await runCli(["repos", "krasnoperov/usertold"], { stdout: reposShowOut.stream, stderr: createBufferStream().stream, config }), 0);
    assert.match(reposShowOut.read(), /Repository: krasnoperov\/usertold/);

    const connectHelp = createBufferStream();
    assert.equal(await runCli(["connect", "--help"], { stdout: connectHelp.stream, stderr: createBufferStream().stream }), 0);
    assert.match(connectHelp.read(), /patchrelay linear connect/);

    const installationsHelp = createBufferStream();
    assert.equal(await runCli(["installations", "--help"], { stdout: installationsHelp.stream, stderr: createBufferStream().stream }), 0);
    assert.match(installationsHelp.read(), /patchrelay linear connect/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }

  const flagError = createBufferStream();
  assert.equal(
    await runCli(["repo", "link", "krasnoperov/demo", "--workspace", "demo", "--team", "DEM", "--bogus"], {
      stdout: createBufferStream().stream,
      stderr: flagError.stream,
    }),
    1,
  );
  assert.match(flagError.read(), /patchrelay repo link <github-repo>/);
  assert.match(flagError.read(), /Error: Unknown flag: --bogus/);
});

test("cli repo link reuses the managed local clone root and supports --path overrides", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-repo-link-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const managedRoot = path.join(baseDir, "managed");
  const reusedRepoPath = path.join(managedRoot, "usertold");
  const overrideRepoPath = path.join(baseDir, "override-repo");

  try {
    initializeGitRepo(reusedRepoPath, "krasnoperov/usertold");
    initializeGitRepo(overrideRepoPath, "krasnoperov/mafia");
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_SYSTEMD_DIR: path.join(baseDir, "systemd"),
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

        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
        setReposRoot(configPath, managedRoot);

        const operatorData = {
          close() {},
          async syncLinearWorkspace(workspace?: string) {
            assert.equal(workspace, "usertold");
            return {
              installation: { id: 7, workspaceName: "Workspace Seven", workspaceKey: "USERTOLD" },
              teams: [
                { id: "team-use", key: "USE", name: "Usertold" },
                { id: "team-maf", key: "MAF", name: "Mafia" },
              ],
              projects: [{ id: "project-web", name: "Website", teamIds: ["team-use", "team-maf"] }],
            };
          },
        } as unknown as CliDataAccess;

        {
          const stdout = createBufferStream();
          const stderr = createBufferStream();
          assert.equal(
            await runCli(["repo", "link", "krasnoperov/usertold", "--workspace", "usertold", "--team", "USE"], {
              stdout: stdout.stream,
              stderr: stderr.stream,
              data: operatorData,
              runInteractive: async () => 0,
            }),
            0,
            stderr.read(),
          );
        }
        {
          const stdout = createBufferStream();
          const stderr = createBufferStream();
          assert.equal(
            await runCli([
              "repo",
              "link",
              "krasnoperov/mafia",
              "--workspace",
              "usertold",
              "--team",
              "MAF",
              "--project",
              "Website",
              "--path",
              overrideRepoPath,
            ], {
              stdout: stdout.stream,
              stderr: stderr.stream,
              data: operatorData,
              runInteractive: async () => 0,
            }),
            0,
            stderr.read(),
          );
        }

        const config = loadConfig(configPath, { profile: "write_config" });
        assert.equal(config.repositories.find((repository) => repository.githubRepo === "krasnoperov/usertold")?.localPath, reusedRepoPath);
        assert.equal(config.repositories.find((repository) => repository.githubRepo === "krasnoperov/mafia")?.localPath, overrideRepoPath);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli issue and service groups expose the supported operator flow", async () => {
  const issueHelp = createBufferStream();
  assert.equal(await runCli(["issue", "--help"], { stdout: issueHelp.stream, stderr: createBufferStream().stream }), 0);
  assert.match(issueHelp.read(), /patchrelay issue <command>/);
  assert.match(issueHelp.read(), /watch <issueKey>/);
  assert.doesNotMatch(issueHelp.read(), /report <issueKey>/);
  assert.doesNotMatch(issueHelp.read(), /events <issueKey>/);

  const serviceHelp = createBufferStream();
  assert.equal(await runCli(["service", "--help"], { stdout: serviceHelp.stream, stderr: createBufferStream().stream }), 0);
  assert.match(serviceHelp.read(), /patchrelay service <command>/);
  assert.match(serviceHelp.read(), /status \[--json\]/);

  const serviceJson = createBufferStream();
  assert.equal(
    await runCli(["service", "status", "--json"], {
      stdout: serviceJson.stream,
      stderr: createBufferStream().stream,
      runCommand: async (_command, args) => {
        if (args[0] === "systemctl") {
          return {
            exitCode: 0,
            stdout: [
              "Id=patchrelay.service",
              "LoadState=loaded",
              "UnitFileState=enabled",
              "ActiveState=active",
              "SubState=running",
              "FragmentPath=/etc/systemd/system/patchrelay.service",
              "ExecMainPID=4242",
            ].join("\n"),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    }),
    0,
  );
  const parsed = JSON.parse(serviceJson.read()) as Record<string, unknown>;
  assert.equal(parsed.service, "patchrelay");
  assert.equal(parsed.unit, "patchrelay.service");
  assert.equal((parsed.systemd as Record<string, unknown>).ActiveState, "active");
  assert.equal((parsed.systemd as Record<string, unknown>).ExecMainPID, "4242");
  assert.equal(typeof (parsed.health as { reachable?: boolean }).reachable, "boolean");
});

test("cli dashboard aliases resolve to the TUI command", async () => {
  for (const command of [["dashboard"], ["dash"], ["d"]] as const) {
    const helpOut = createBufferStream();
    assert.equal(await runCli([...command, "--help"], { stdout: helpOut.stream, stderr: createBufferStream().stream }), 0);
    assert.match(helpOut.read(), /dashboard \[--issue <issueKey>\]/);
  }
});

test("cli dashboard reports a clean error when stdin is not a TTY", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "patchrelay-dashboard-"));
  try {
    const configPath = path.join(tempDir, "config.json");
    mkdirSync(path.join(tempDir, "repo"), { recursive: true });
    writeExternalConfig(configPath, tempDir);

    const result = runCliProcess(["dashboard"], {
      cwd: process.cwd(),
      env: {
        PATCHRELAY_CONFIG: configPath,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an interactive TTY/i);
    assert.doesNotMatch(result.stderr, /thread\.turns is not iterable/i);
    assert.doesNotMatch(result.stderr, /Raw mode is not supported/i);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cli process paths still handle help, version, and unknown commands", () => {
  const help = runCliProcess(["help"]);
  assert.equal(help.status, 0);

  const version = runCliProcess(["version"]);
  assert.equal(version.status, 0);

  const unknown = runCliProcess(["frobnicate"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Error: Unknown command: frobnicate/);
});

test("cli feed command has been removed", async () => {
  const stdout = createBufferStream();
  const stderr = createBufferStream();
  assert.equal(await runCli(["feed"], { stdout: stdout.stream, stderr: stderr.stream }), 1);
  assert.equal(stdout.read(), "");
  assert.match(stderr.read(), /Unknown command: feed/);
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

test("cli init writes XDG config files and service install manages the system unit", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-init-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const systemdDir = path.join(baseDir, "systemd");

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_SYSTEMD_DIR: systemdDir,
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
        assert.match(initText, /The system service is installed for you/);
        assert.match(initText, /Open Linear Settings > API > Applications/);
        assert.match(initText, /4\. Run `patchrelay linear connect`/);
        assert.match(initText, /6\. Run `patchrelay repo link <owner\/repo> --workspace <workspace> --team <team>`/);

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
          "sudo systemctl daemon-reload",
          "sudo systemctl enable patchrelay.service",
          "sudo systemctl reload-or-restart patchrelay.service",
        ]);

        const installOut = createBufferStream();
        assert.equal(
          await runCli(["service", "install", "--write-only"], {
            stdout: installOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        const unitPath = path.join(systemdDir, "patchrelay.service");
        const unit = readFileSync(unitPath, "utf8");
        assert.match(unit, /ExecStart=\/usr\/bin\/env patchrelay serve/);
        assert.match(unit, new RegExp(`Environment=PATCHRELAY_CONFIG=${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        assert.match(unit, /EnvironmentFile=-.*runtime\.env/);
        assert.match(unit, /LoadCredentialEncrypted=linear-webhook-secret/);

        const commands: string[] = [];
        assert.equal(
          await runCli(["service", "restart", "--json"], {
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
          "sudo systemctl daemon-reload",
          "sudo systemctl reload-or-restart patchrelay.service",
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
        PATCHRELAY_SYSTEMD_DIR: path.join(baseDir, "systemd"),
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

test("cli repo link writes repository-first config and reuses existing clones", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-repo-config-"));
  const systemdDir = path.join(baseDir, "systemd");
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const reposRoot = path.join(baseDir, "repos");
  const repoPath = path.join(reposRoot, "usertold");

  try {
    initializeGitRepo(repoPath, "krasnoperov/usertold");
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_SYSTEMD_DIR: systemdDir,
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

        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
        setReposRoot(configPath, reposRoot);

        const operatorData = {
          close() {},
          async syncLinearWorkspace(workspace?: string) {
            assert.equal(workspace, "usertold");
            return {
              installation: { id: 7, workspaceName: "Workspace Seven", workspaceKey: "USERTOLD" },
              teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
              projects: [{ id: "project-web", name: "Website", teamIds: ["team-use"] }],
            };
          },
        } as const;

        const linkOut = createBufferStream();
        {
          const stderr = createBufferStream();
          assert.equal(
            await runCli(["repo", "link", "krasnoperov/usertold", "--workspace", "usertold", "--team", "USE"], {
              stdout: linkOut.stream,
              stderr: stderr.stream,
              data: operatorData as unknown as CliDataAccess,
              runInteractive: async () => 0,
            }),
            0,
            stderr.read(),
          );
        }
        assert.match(linkOut.read(), /Linked krasnoperov\/usertold|Verified krasnoperov\/usertold/);
        assert.match(linkOut.read(), /Path: .* \(reused\)/);

        const config = loadConfig(configPath, { profile: "write_config" });
        assert.equal(config.repositories[0]?.githubRepo, "krasnoperov/usertold");
        assert.equal(config.repositories[0]?.localPath, repoPath);
        assert.equal(config.repositories[0]?.workspace, "USERTOLD");
        assert.deepEqual(config.repositories[0]?.issueKeyPrefixes, ["USE"]);
        assert.equal(config.projects[0]?.id, "krasnoperov/usertold");
        assert.equal(config.projects[0]?.repoPath, repoPath);
        assert.equal(config.projects[0]?.branchPrefix, "krasnoperov-usertold");
        assert.equal(config.projects[0]?.worktreeRoot, path.join(dataHome, "patchrelay", "worktrees", "krasnoperov", "usertold"));

      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli repo list, show, and unlink use repository-first identities", { concurrency: false }, async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-repo-ops-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const reposRoot = path.join(baseDir, "repos");
  const repoPath = path.join(reposRoot, "usertold");

  try {
    initializeGitRepo(repoPath, "krasnoperov/usertold");
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_SYSTEMD_DIR: path.join(baseDir, "systemd"),
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

        const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
        setReposRoot(configPath, reposRoot);
        await writeRunnerBinaries(configPath, { gitBin: "git", codexBin: "true" });

        const operatorData = {
          close() {},
          async syncLinearWorkspace() {
            return {
              installation: { id: 8, workspaceName: "Workspace Eight", workspaceKey: "USERTOLD" },
              teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
              projects: [],
            };
          },
        } as const;

        {
          const stdout = createBufferStream();
          const stderr = createBufferStream();
          assert.equal(
            await runCli(["repo", "link", "krasnoperov/usertold", "--workspace", "usertold", "--team", "USE"], {
              stdout: stdout.stream,
              stderr: stderr.stream,
              data: operatorData as unknown as CliDataAccess,
              runInteractive: async () => 0,
            }),
            0,
            stderr.read(),
          );
        }

        const listOut = createBufferStream();
        assert.equal(await runCli(["repo", "list"], { stdout: listOut.stream, stderr: createBufferStream().stream }), 0);
        assert.match(listOut.read(), /krasnoperov\/usertold/);

        const showJson = createBufferStream();
        assert.equal(await runCli(["repo", "show", "krasnoperov/usertold", "--json"], { stdout: showJson.stream, stderr: createBufferStream().stream }), 0);
        assert.equal((JSON.parse(showJson.read()) as { repository: { githubRepo: string } }).repository.githubRepo, "krasnoperov/usertold");

        const unlinkOut = createBufferStream();
        assert.equal(
          await runCli(["repo", "unlink", "krasnoperov/usertold"], {
            stdout: unlinkOut.stream,
            stderr: createBufferStream().stream,
            runInteractive: async () => 0,
          }),
          0,
        );
        assert.match(unlinkOut.read(), /Unlinked krasnoperov\/usertold/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli linear commands cover workspace OAuth flows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-linear-workspaces-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        PATCHRELAY_SYSTEMD_DIR: path.join(baseDir, "systemd"),
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

        const data = {
          close() {},
          async connect() {
            return {
              state: "state-1",
              authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
              redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
            };
          },
          async connectStatus() {
            return {
              state: "state-1",
              status: "completed" as const,
              installation: { id: 1, workspaceName: "Workspace One", workspaceKey: "WS1" },
            };
          },
          async listLinearWorkspaces() {
            return {
              workspaces: [
                {
                  installation: { id: 1, workspaceName: "Workspace One", workspaceKey: "WS1" },
                  linkedRepos: ["krasnoperov/usertold"],
                  teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
                  projects: [{ id: "project-web", name: "Website", teamIds: ["team-use"] }],
                },
              ],
            };
          },
          async syncLinearWorkspace(workspace?: string) {
            assert.equal(workspace, "usertold");
            return {
              installation: { id: 1, workspaceName: "Workspace One", workspaceKey: "WS1" },
              teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
              projects: [{ id: "project-web", name: "Website", teamIds: ["team-use"] }],
            };
          },
          async disconnectLinearWorkspace(workspace: string) {
            assert.equal(workspace, "usertold");
            return {
              installation: { id: 1, workspaceName: "Workspace One", workspaceKey: "WS1" },
            };
          },
        } as const;

        const connectOut = createBufferStream();
        assert.equal(
          await runCli(["linear", "connect"], {
            stdout: connectOut.stream,
            stderr: createBufferStream().stream,
            data: data as unknown as CliDataAccess,
            openExternal: async () => true,
            connectPollIntervalMs: 1,
          }),
          0,
        );
        assert.match(connectOut.read(), /Opened browser for Linear OAuth/);
        assert.match(connectOut.read(), /Connected Workspace One/);

        const listOut = createBufferStream();
        assert.equal(await runCli(["linear", "list"], { stdout: listOut.stream, stderr: createBufferStream().stream, data: data as unknown as CliDataAccess }), 0);
        assert.match(listOut.read(), /WS1 {2}repos=1 teams=1 projects=1/);

        const syncJson = createBufferStream();
        assert.equal(await runCli(["linear", "sync", "usertold", "--json"], { stdout: syncJson.stream, stderr: createBufferStream().stream, data: data as unknown as CliDataAccess }), 0);
        assert.equal((JSON.parse(syncJson.read()) as { installation: { workspaceKey: string } }).installation.workspaceKey, "WS1");

        const disconnectOut = createBufferStream();
        assert.equal(await runCli(["linear", "disconnect", "usertold"], { stdout: disconnectOut.stream, stderr: createBufferStream().stream, data: data as unknown as CliDataAccess }), 0);
        assert.match(disconnectOut.read(), /Disconnected WS1/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});


test("cli linear connect reuses an existing installation without repo-specific output", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-linear-reuse-"));
  try {
    writeExternalConfig(path.join(baseDir, "patchrelay.json"), baseDir);
    await withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "patchrelay.json"),
      },
      async () => {
        const data = {
          close() {},
          async connect() {
            return {
              completed: true as const,
              reusedExisting: true as const,
              installation: { id: 7, workspaceName: "Workspace Seven" },
            };
          },
        } as const;

        const connectOut = createBufferStream();
        assert.equal(
          await runCli(["linear", "connect"], {
            data: data as unknown as CliDataAccess,
            stdout: connectOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        assert.match(connectOut.read(), /Reused existing Linear installation 7/);
        assert.doesNotMatch(connectOut.read(), /Linked repo/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli linear commands support json output and validation failures", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-linear-json-"));
  try {
    writeExternalConfig(path.join(baseDir, "patchrelay.json"), baseDir);
    await withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "patchrelay.json"),
      },
      async () => {
        const data = {
          close() {},
          async connect() {
            return {
              state: "state-1",
              authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
              redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
            };
          },
          async listLinearWorkspaces() {
            return {
              workspaces: [
                {
                  installation: {
                    id: 1,
                    workspaceName: "Workspace One",
                    workspaceKey: "WS1",
                    actorName: "PatchRelay App",
                    actorId: "actor-1",
                  },
                  linkedRepos: ["krasnoperov/usertold"],
                  teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
                  projects: [{ id: "project-web", name: "Website", teamIds: ["team-use"] }],
                },
              ],
            };
          },
          async syncLinearWorkspace(workspace?: string) {
            if (workspace === "missing-workspace") {
              throw new Error("Unknown workspace: missing-workspace");
            }
            return {
              installation: { id: 1, workspaceName: "Workspace One", workspaceKey: "WS1" },
              teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
              projects: [{ id: "project-web", name: "Website", teamIds: ["team-use"] }],
            };
          },
        } as const;

        const connectJson = createBufferStream();
        assert.equal(
          await runCli(["linear", "connect", "--json"], {
            data: data as unknown as CliDataAccess,
            stdout: connectJson.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        assert.deepEqual(JSON.parse(connectJson.read()), {
          state: "state-1",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        });

        const listJson = createBufferStream();
        assert.equal(
          await runCli(["linear", "list", "--json"], {
            data: data as unknown as CliDataAccess,
            stdout: listJson.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        const listResult = JSON.parse(listJson.read()) as { workspaces: Array<{ linkedRepos: string[] }> };
        assert.equal(listResult.workspaces.length, 1);
        assert.deepEqual(listResult.workspaces[0]?.linkedRepos, ["krasnoperov/usertold"]);

        const syncError = createBufferStream();
        assert.equal(
          await runCli(["linear", "sync", "missing-workspace"], {
            data: data as unknown as CliDataAccess,
            stdout: createBufferStream().stream,
            stderr: syncError.stream,
          }),
          1,
        );
        assert.match(syncError.read(), /Unknown workspace: missing-workspace/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("cli workspace commands use the local HTTP service end to end", async (t) => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-cli-http-"));
  let app: Awaited<ReturnType<typeof buildHttpServer>> | undefined;
  try {
    const config = createConfig(baseDir);

    let oauthPollCount = 0;
    app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        createLinearOAuthStart: () => ({
          state: "state-http",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-http",
          redirectUri: config.linear.oauth!.redirectUri,
        }),
        getLinearOAuthStateStatus: (state: string) => {
          if (state !== "state-http") {
            return undefined;
          }
          oauthPollCount += 1;
          if (oauthPollCount < 2) {
            return { state, status: "pending" as const };
          }
          return {
            state,
            status: "completed" as const,
            installation: { id: 7, workspaceName: "Workspace Seven" },
          };
        },
        listLinearWorkspaces: () => [
          {
            installation: { id: 7, workspaceName: "Workspace Seven" },
            linkedRepos: ["krasnoperov/usertold"],
            teams: [{ id: "team-use", key: "USE", name: "Usertold" }],
            projects: [],
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
    const configPath = path.join(baseDir, "patchrelay.json");
    writeExternalConfig(configPath, baseDir, {
      serverPort: address.port,
      redirectUri: config.linear.oauth.redirectUri,
    });

    await withEnv(
      {
        PATCHRELAY_CONFIG: configPath,
      },
      async () => {
        const connectOut = createBufferStream();
        assert.equal(
          await runCli(["linear", "connect", "--no-open"], {
            stdout: connectOut.stream,
            stderr: createBufferStream().stream,
            connectPollIntervalMs: 1,
          }),
          0,
        );
        assert.match(connectOut.read(), /Connected Workspace Seven/);

        const listOut = createBufferStream();
        assert.equal(
          await runCli(["linear", "list"], {
            stdout: listOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        assert.match(listOut.read(), /Workspace Seven/);
        assert.match(listOut.read(), /repos=1/);
      },
    );

  } finally {
    await app?.close().catch(() => {});
    rmSync(baseDir, { recursive: true, force: true });
  }
});
