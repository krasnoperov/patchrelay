import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { RunOrchestrator } from "../src/run-orchestrator.ts";
import type { AppConfig, LinearClient } from "../src/types.ts";

// Captures every log entry written through pino so tests can assert on
// the structured `reason` field without parsing log strings.
function captureLogger(): { logger: pino.Logger; entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  const stream = {
    write(line: string) {
      try {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // ignore non-JSON pino output
      }
      return true;
    },
  };
  const logger = pino({ level: "trace" }, stream as unknown as NodeJS.WritableStream);
  return { logger, entries };
}

function createConfig(baseDir: string): AppConfig {
  return {
    server: { bind: "127.0.0.1", port: 8787, healthPath: "/health", readinessPath: "/ready" },
    ingress: { linearWebhookPath: "/webhooks/linear", githubWebhookPath: "/webhooks/github", maxBodyBytes: 262144, maxTimestampSkewSeconds: 60 },
    logging: { level: "info", format: "logfmt", filePath: path.join(baseDir, "patchrelay.log") },
    database: { path: ":memory:", wal: false },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: { clientId: "c", clientSecret: "s", redirectUri: "http://127.0.0.1:8787/cb", scopes: ["read"], actor: "user" },
      tokenEncryptionKey: "test-encryption-key",
    },
    operatorApi: { enabled: false },
    runner: {
      gitBin: "git",
      codex: { bin: "node", args: ["app-server"], approvalPolicy: "never", sandboxMode: "danger-full-access", persistExtendedHistory: false },
    },
    projects: [{
      id: "proj",
      repoPath: path.join(baseDir, "repo"),
      worktreeRoot: path.join(baseDir, "worktrees"),
      issueKeyPrefixes: ["PRJ"],
      linearTeamIds: ["team"],
      allowLabels: [],
      triggerEvents: ["statusChanged"],
      branchPrefix: "prj",
      github: { repoFullName: "owner/repo" },
    }],
    secretSources: {},
  };
}

function buildOrchestrator(baseDir: string, logger: pino.Logger) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  const enqueueCalls: Array<{ projectId: string; issueId: string }> = [];
  const codex = {
    startThreadForIssueTriage: async () => ({ id: "triage-1", cwd: "/tmp", preview: "", status: "idle", turns: [] }),
    startThread: async () => ({ threadId: "thread-1" }),
    steerTurn: async () => undefined,
    readThread: async () => ({ id: "thread-1", turns: [] }),
  };
  const linearProvider: { forProject(projectId: string): Promise<LinearClient | undefined> } = {
    forProject: async () => undefined,
  };
  const orchestrator = new RunOrchestrator(
    config,
    db,
    codex as never,
    linearProvider as never,
    (projectId, issueId) => enqueueCalls.push({ projectId, issueId }),
    logger,
  );
  return { config, db, orchestrator, enqueueCalls };
}

function reasonsFor(entries: Array<Record<string, unknown>>, msgPattern: RegExp): string[] {
  return entries
    .filter((entry) => typeof entry.msg === "string" && msgPattern.test(entry.msg as string))
    .map((entry) => String(entry.reason));
}

test("orchestrator.run() logs reason=issue_missing when called for an unknown issue", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-orchestrator-diag-"));
  const { logger, entries } = captureLogger();
  try {
    const { orchestrator } = buildOrchestrator(baseDir, logger);
    await orchestrator.run({ projectId: "proj", issueId: "ghost" });
    const reasons = reasonsFor(entries, /^Skipped issue run/);
    assert.ok(reasons.includes("issue_missing"), `got reasons: ${JSON.stringify(reasons)}`);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("orchestrator.run() logs reason=active_run_present when an active run is in flight", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-orchestrator-active-run-"));
  const { logger, entries } = captureLogger();
  try {
    const { db, orchestrator } = buildOrchestrator(baseDir, logger);
    const issue = db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-active",
      issueKey: "PRJ-1",
      branchName: "feat/x",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "implementation",
    });
    db.upsertIssue({ projectId: "proj", linearIssueId: "issue-active", activeRunId: run.id });

    await orchestrator.run({ projectId: "proj", issueId: "issue-active" });
    const reasons = reasonsFor(entries, /^Skipped issue run/);
    assert.ok(reasons.includes("active_run_present"), `got reasons: ${JSON.stringify(reasons)}`);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("orchestrator.run() logs reason=no_workflow_task_derivable when nothing is pending", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-orchestrator-no-workflowTask-"));
  const { logger, entries } = captureLogger();
  try {
    const { db, orchestrator } = buildOrchestrator(baseDir, logger);
    db.upsertIssue({
      projectId: "proj",
      linearIssueId: "issue-quiet",
      issueKey: "PRJ-2",
      branchName: "feat/y",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 9,
      prState: "open",
    });

    await orchestrator.run({ projectId: "proj", issueId: "issue-quiet" });
    const reasons = reasonsFor(entries, /^Skipped issue run/);
    assert.ok(reasons.includes("no_workflow_task_derivable"), `got reasons: ${JSON.stringify(reasons)}`);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
