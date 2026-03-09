import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.js";
import { LaunchRunner } from "../src/launcher.js";
import type { AppConfig } from "../src/types.js";

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
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
      webhookSecret: "secret",
    },
    runner: {
      zmxBin: "zmx",
      gitBin: "git",
      launch: {
        shell: "codex",
        args: ["exec", "{prompt}"],
      },
    },
    projects: [
      {
        id: "patchrelay",
        repoPath: baseDir,
        worktreeRoot: path.join(baseDir, "worktrees"),
        workflowFiles: {
          implementation: path.join(baseDir, "implementation.md"),
          review: path.join(baseDir, "review.md"),
          deploy: path.join(baseDir, "deploy.md"),
        },
        workflowStatuses: {
          implementation: "Start",
          review: "Review",
          deploy: "Deploy",
        },
        linearTeamIds: ["ENG"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "patchrelay",
      },
    ],
  };
}

function createRunner(baseDir: string) {
  const config = createConfig(baseDir);
  const db = new PatchRelayDatabase(config.database.path, true);
  db.runMigrations();
  return new LaunchRunner(config, db, pino({ enabled: false }), "test-worker");
}

test("getSessionState treats completion history as stronger than list membership", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-launcher-"));
  try {
    const runner = createRunner(baseDir);
    (runner as unknown as { zmx: { history: () => Promise<string>; listSessions: () => Promise<string[]> } }).zmx = {
      history: async () => "...\nZMX_TASK_COMPLETED:0\n",
      listSessions: async () => ["eng-123r-12"],
    };

    const state = await runner.getSessionState("eng-123r-12");
    assert.deepEqual(state, { kind: "completed", exitCode: 0 });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("getSessionState falls back to list membership for running sessions", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-launcher-"));
  try {
    const runner = createRunner(baseDir);
    (runner as unknown as { zmx: { history: () => Promise<string>; listSessions: () => Promise<string[]> } }).zmx = {
      history: async () => "session output without completion marker",
      listSessions: async () => ["eng-123r-12"],
    };

    const state = await runner.getSessionState("eng-123r-12");
    assert.deepEqual(state, { kind: "running" });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("getSessionState reports missing when neither history nor list prove the session is live", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-launcher-"));
  try {
    const runner = createRunner(baseDir);
    (runner as unknown as { zmx: { history: () => Promise<string>; listSessions: () => Promise<string[]> } }).zmx = {
      history: async () => {
        throw new Error("not found");
      },
      listSessions: async () => [],
    };

    const state = await runner.getSessionState("eng-123r-12");
    assert.deepEqual(state, { kind: "missing" });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("monitorSession finalizes from heartbeat polling even when zmx wait stays stuck", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-launcher-"));
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  try {
    const runner = createRunner(baseDir);
    let heartbeatCallback: (() => void) | undefined;
    let finished:
      | {
          projectId: string;
          linearIssueId: string;
          runId: number;
          sessionId: number;
          exitCode: number;
        }
      | undefined;

    class FakeChild extends EventEmitter {
      stdout = new EventEmitter();
      stderr = new EventEmitter();
      killCalled = false;

      kill(): void {
        this.killCalled = true;
      }
    }

    const fakeChild = new FakeChild();
    const fakeAttachClient = { killCalled: false, kill() { this.killCalled = true; } };

    global.setInterval = ((callback: (...args: never[]) => void) => {
      heartbeatCallback = () => callback();
      return { unref() {} } as NodeJS.Timeout;
    }) as typeof setInterval;
    global.clearInterval = (() => undefined) as typeof clearInterval;

    (runner as unknown as { attachedClients: Map<number, { kill: () => void }> }).attachedClients.set(77, fakeAttachClient);
    (runner as unknown as { zmx: { spawnWait: () => FakeChild } }).zmx = {
      spawnWait: () => fakeChild,
    };
    (runner as unknown as { getSessionState: () => Promise<{ kind: "completed"; exitCode: number }> }).getSessionState = async () => ({
      kind: "completed",
      exitCode: 0,
    });
    (runner as unknown as { finishRunLifecycle: typeof finished extends never ? never : (params: NonNullable<typeof finished>) => void }).finishRunLifecycle = (
      params,
    ) => {
      finished = params;
    };

    (runner as unknown as {
      monitorSession: (params: {
        project: { id: string };
        issue: { id: string };
        run: { id: number };
        session: { id: number };
        plan: { sessionName: string; worktreePath: string };
      }) => void;
    }).monitorSession({
      project: { id: "patchrelay" },
      issue: { id: "issue_1" },
      run: { id: 12 },
      session: { id: 77 },
      plan: { sessionName: "eng-1r-12", worktreePath: baseDir },
    });

    assert.ok(heartbeatCallback, "expected monitorSession to register a heartbeat callback");
    heartbeatCallback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(finished, {
      projectId: "patchrelay",
      linearIssueId: "issue_1",
      runId: 12,
      sessionId: 77,
      exitCode: 0,
    });
    assert.equal(fakeChild.killCalled, true);
    assert.equal(fakeAttachClient.killCalled, true);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
