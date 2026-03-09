import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { buildHttpServer } from "../src/http.js";
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
      graphqlUrl: "https://linear.example/graphql",
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: true,
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

test("health endpoint includes build version metadata from the built artifact", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-"));
  const originalCwd = process.cwd();

  try {
    mkdirSync(path.join(baseDir, "dist"), { recursive: true });
    writeFileSync(
      path.join(baseDir, "dist/build-info.json"),
      `${JSON.stringify(
        {
          service: "patchrelay",
          version: "0.1.0-test",
          commit: "abc123def456",
          builtAt: "2026-03-09T08:55:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.chdir(baseDir);

    const config = createConfig(baseDir);
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getIssueOverview: async () => undefined,
        getIssueReport: async () => undefined,
      } as never,
      pino({ enabled: false }),
    );

    const response = await app.inject({
      method: "GET",
      url: config.server.healthPath,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      service: "patchrelay",
      version: "0.1.0-test",
      commit: "abc123def456",
      builtAt: "2026-03-09T08:55:00.000Z",
    });

    const home = await app.inject({
      method: "GET",
      url: "/",
    });
    assert.match(home.body, /codex app-server/);
    assert.match(home.body, /api\/issues\/:issueKey\/report/);

    await app.close();
  } finally {
    process.chdir(originalCwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("http routes handle webhook validation and issue/report/live/events lookups", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-routes-"));

  try {
    const config = createConfig(baseDir);
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async ({ webhookId }) => ({
          status: 202,
          body: { ok: true, webhookId },
        }),
        getIssueOverview: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                latestStageRun: { id: 7, stage: "development", status: "completed" },
              }
            : undefined,
        getIssueReport: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                stages: [{ stageRun: { id: 7, stage: "development", status: "completed" } }],
              }
            : undefined,
        getActiveStageStatus: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                stageRun: { id: 8, stage: "review", status: "running" },
                liveThread: { threadId: "thread-1", threadStatus: "running" },
              }
            : undefined,
        getStageEvents: async (issueKey: string, stageRunId: number) =>
          issueKey === "USE-42" && stageRunId === 8
            ? {
                issue: { issueKey: "USE-42" },
                stageRun: { id: 8, stage: "review", status: "running" },
                events: [{ id: 1, method: "turn/started" }],
              }
            : undefined,
      } as never,
      pino({ enabled: false }),
    );

    const missingHeader = await app.inject({
      method: "POST",
      url: config.ingress.linearWebhookPath,
      payload: { ok: true },
    });
    assert.equal(missingHeader.statusCode, 400);
    assert.deepEqual(missingHeader.json(), { ok: false, reason: "missing_delivery_header" });

    const acceptedWebhook = await app.inject({
      method: "POST",
      url: config.ingress.linearWebhookPath,
      headers: {
        "content-type": "application/json",
        "linear-delivery": "delivery-1",
      },
      payload: { ok: true },
    });
    assert.equal(acceptedWebhook.statusCode, 202);
    assert.deepEqual(acceptedWebhook.json(), { ok: true, webhookId: "delivery-1" });

    const overview = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42",
    });
    assert.equal(overview.statusCode, 200);
    assert.deepEqual(overview.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      latestStageRun: { id: 7, stage: "development", status: "completed" },
    });

    const missingOverview = await app.inject({
      method: "GET",
      url: "/api/issues/USE-404",
    });
    assert.equal(missingOverview.statusCode, 404);
    assert.deepEqual(missingOverview.json(), { ok: false, reason: "issue_not_found" });

    const report = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/report",
    });
    assert.equal(report.statusCode, 200);
    assert.deepEqual(report.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      stages: [{ stageRun: { id: 7, stage: "development", status: "completed" } }],
    });

    const live = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/live",
    });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      stageRun: { id: 8, stage: "review", status: "running" },
      liveThread: { threadId: "thread-1", threadStatus: "running" },
    });

    const missingLive = await app.inject({
      method: "GET",
      url: "/api/issues/USE-404/live",
    });
    assert.equal(missingLive.statusCode, 404);
    assert.deepEqual(missingLive.json(), { ok: false, reason: "active_stage_not_found" });

    const events = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/stages/8/events",
    });
    assert.equal(events.statusCode, 200);
    assert.deepEqual(events.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      stageRun: { id: 8, stage: "review", status: "running" },
      events: [{ id: 1, method: "turn/started" }],
    });

    const missingEvents = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/stages/999/events",
    });
    assert.equal(missingEvents.statusCode, 404);
    assert.deepEqual(missingEvents.json(), { ok: false, reason: "stage_run_not_found" });

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
