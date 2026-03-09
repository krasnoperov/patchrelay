import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("loadConfig expands env vars, resolves paths, and honors runtime overrides", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-"));
  const originalCwd = process.cwd();

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(path.join(baseDir, "repo"), { recursive: true });
    mkdirSync(path.join(baseDir, "worktrees"), { recursive: true });
    writeFileSync(
      path.join(baseDir, "config", "patchrelay.yaml"),
      `
server:
  bind: 0.0.0.0
  port: 9999
ingress:
  linear_webhook_path: /webhooks/linear
  max_body_bytes: 262144
  max_timestamp_skew_seconds: 60
logging:
  file_path: \${LOG_FILE_PATH:-./logs/default.log}
  webhook_archive_dir: \${ARCHIVE_DIR:-./archive}
database:
  path: ./data/patchrelay.sqlite
linear:
  webhook_secret_env: CUSTOM_LINEAR_SECRET
projects:
  - id: usertold
    repo_path: ./repo
    worktree_root: ./worktrees
    workflow_files:
      development: ./DEVELOPMENT.md
      review: ./REVIEW.md
      deploy: ./DEPLOY.md
      cleanup: ./CLEANUP.md
    workflow_statuses:
      development: Start
      review: Review
      deploy: Deploy
      cleanup: Cleanup
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        PATCHRELAY_LOG_FILE: path.join(baseDir, "runtime.log"),
        PATCHRELAY_DB_PATH: path.join(baseDir, "runtime.sqlite"),
        PATCHRELAY_WEBHOOK_ARCHIVE_DIR: path.join(baseDir, "runtime-archive"),
        CUSTOM_LINEAR_SECRET: "top-secret",
        LOG_FILE_PATH: path.join(baseDir, "ignored.log"),
        ARCHIVE_DIR: path.join(baseDir, "ignored-archive"),
      },
      () => {
        process.chdir(baseDir);
        const config = loadConfig();
        assert.equal(config.server.bind, "0.0.0.0");
        assert.equal(config.server.port, 9999);
        assert.equal(config.logging.filePath, path.join(baseDir, "runtime.log"));
        assert.equal(config.logging.webhookArchiveDir, path.join(baseDir, "runtime-archive"));
        assert.equal(config.database.path, path.join(baseDir, "runtime.sqlite"));
        assert.equal(config.linear.webhookSecret, "top-secret");
        assert.equal(config.projects[0]?.repoPath, path.join(baseDir, "repo"));
        assert.equal(config.projects[0]?.worktreeRoot, path.join(baseDir, "worktrees"));
        assert.equal(config.projects[0]?.workflowFiles.review, path.join(baseDir, "REVIEW.md"));
      },
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects missing required webhook secret by default", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-missing-secret-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    writeFileSync(
      path.join(baseDir, "config", "patchrelay.yaml"),
      `
server:
  bind: 127.0.0.1
  port: 8787
ingress:
  linear_webhook_path: /webhooks/linear
  max_body_bytes: 262144
  max_timestamp_skew_seconds: 60
logging:
  file_path: ./patchrelay.log
database:
  path: ./data/patchrelay.sqlite
linear:
  webhook_secret_env: REQUIRED_SECRET
projects:
  - id: usertold
    repo_path: ./repo
    worktree_root: ./worktrees
    workflow_files:
      development: ./DEVELOPMENT.md
      review: ./REVIEW.md
      deploy: ./DEPLOY.md
      cleanup: ./CLEANUP.md
    workflow_statuses:
      development: Start
      review: Review
      deploy: Deploy
      cleanup: Cleanup
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: undefined,
      },
      () => {
        assert.throws(() => loadConfig(), /Missing env var REQUIRED_SECRET/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
