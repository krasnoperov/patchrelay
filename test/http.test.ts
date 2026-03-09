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
