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

    await app.close();
  } finally {
    process.chdir(originalCwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
});
