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
  api_token_env: CUSTOM_LINEAR_TOKEN
operator_api:
  enabled: true
  bearer_token_env: PATCHRELAY_OPERATOR_TOKEN
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
      development_active: Implementing
      review_active: Reviewing
      deploy_active: Deploying
      cleanup: Cleanup
    trigger_events: [statusChanged]
    branch_prefix: use
runner:
  codex:
    shell_bin: /bin/bash
    source_bashrc: true
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
        CUSTOM_LINEAR_TOKEN: "linear-token",
        PATCHRELAY_OPERATOR_TOKEN: "operator-secret",
        LOG_FILE_PATH: path.join(baseDir, "ignored.log"),
        ARCHIVE_DIR: path.join(baseDir, "ignored-archive"),
      },
      () => {
        process.chdir(baseDir);
        const config = loadConfig();
        assert.equal(config.server.bind, "0.0.0.0");
        assert.equal(config.server.port, 9999);
        assert.equal(config.server.readinessPath, "/ready");
        assert.equal(config.logging.filePath, path.join(baseDir, "runtime.log"));
        assert.equal(config.logging.webhookArchiveDir, path.join(baseDir, "runtime-archive"));
        assert.equal(config.database.path, path.join(baseDir, "runtime.sqlite"));
        assert.equal(config.linear.webhookSecret, "top-secret");
        assert.equal(config.linear.apiToken, "linear-token");
        assert.equal(config.operatorApi.enabled, true);
        assert.equal(config.operatorApi.bearerToken, "operator-secret");
        assert.equal(config.projects[0]?.repoPath, path.join(baseDir, "repo"));
        assert.equal(config.projects[0]?.worktreeRoot, path.join(baseDir, "worktrees"));
        assert.equal(config.projects[0]?.workflowFiles.review, path.join(baseDir, "REVIEW.md"));
        assert.equal(config.runner.codex.shellBin, "/bin/bash");
        assert.equal(config.runner.codex.sourceBashrc, true);
      },
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects overlapping project routing and unsafe operator API exposure", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-overlap-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    writeFileSync(
      path.join(baseDir, "config", "patchrelay.yaml"),
      `
server:
  bind: 0.0.0.0
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
operator_api:
  enabled: true
projects:
  - id: one
    repo_path: ./repo-one
    worktree_root: ./worktrees-one
    workflow_files:
      development: ./DEVELOPMENT.md
      review: ./REVIEW.md
      deploy: ./DEPLOY.md
      cleanup: ./CLEANUP.md
    workflow_statuses:
      development: Start
      review: Review
      deploy: Deploy
      development_active: Implementing
      review_active: Reviewing
      deploy_active: Deploying
    issue_key_prefixes: [USE]
    trigger_events: [statusChanged]
    branch_prefix: use
  - id: two
    repo_path: ./repo-two
    worktree_root: ./worktrees-two
    workflow_files:
      development: ./DEVELOPMENT.md
      review: ./REVIEW.md
      deploy: ./DEPLOY.md
      cleanup: ./CLEANUP.md
    workflow_statuses:
      development: Start
      review: Review
      deploy: Deploy
      development_active: Implementing
      review_active: Reviewing
      deploy_active: Deploying
    issue_key_prefixes: [USE]
    trigger_events: [statusChanged]
    branch_prefix: use2
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
      },
      () => {
        assert.throws(() => loadConfig(), /Issue key prefix "USE" is configured for both one and two/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects operator API exposure without a bearer token outside loopback", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-operator-api-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    writeFileSync(
      path.join(baseDir, "config", "patchrelay.yaml"),
      `
server:
  bind: 0.0.0.0
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
operator_api:
  enabled: true
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
      development_active: Implementing
      review_active: Reviewing
      deploy_active: Deploying
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
      },
      () => {
        assert.throws(
          () => loadConfig(),
          /operator_api.enabled requires operator_api.bearer_token_env when server.bind is not 127.0.0.1/,
        );
      },
    );
  } finally {
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
      development_active: Implementing
      review_active: Reviewing
      deploy_active: Deploying
      cleanup: Cleanup
    trigger_events: [statusChanged]
    branch_prefix: use
runner:
  codex:
    source_bashrc: false
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
        const config = loadConfig(undefined, { requireLinearSecret: false });
        assert.equal(config.runner.codex.sourceBashrc, false);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
