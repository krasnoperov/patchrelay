import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

const oauthConfigYaml = `  token_encryption_key_env: PATCHRELAY_TOKEN_ENCRYPTION_KEY
  oauth:
    client_id_env: LINEAR_OAUTH_CLIENT_ID
    client_secret_env: LINEAR_OAUTH_CLIENT_SECRET
    redirect_uri: http://127.0.0.1:8787/oauth/linear/callback
    scopes: [read, write]
    actor: user`;

const oauthEnv = {
  PATCHRELAY_TOKEN_ENCRYPTION_KEY: "enc-secret",
  LINEAR_OAUTH_CLIENT_ID: "oauth-client-id",
  LINEAR_OAUTH_CLIENT_SECRET: "oauth-client-secret",
};

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
  public_base_url: https://patchrelay.example.com
ingress:
  linear_webhook_path: /webhooks/linear
  max_body_bytes: 262144
  max_timestamp_skew_seconds: 60
logging:
  file_path: \${LOG_FILE_PATH:-./logs/default.log}
  webhook_archive_dir: \${ARCHIVE_DIR:-./archive}
database:
  path: ./data/patchrelay.sqlite
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
    trusted_actors:
      ids: [user_123]
      emails: [owner@example.com]
      email_domains: [example.com]
    trigger_events: [statusChanged]
    branch_prefix: use
runner:
  codex:
    shell_bin: /bin/bash
    source_bashrc: true
linear:
  webhook_secret_env: CUSTOM_LINEAR_SECRET
${oauthConfigYaml}
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
        PATCHRELAY_OPERATOR_TOKEN: "operator-secret",
        ...oauthEnv,
        LOG_FILE_PATH: path.join(baseDir, "ignored.log"),
        ARCHIVE_DIR: path.join(baseDir, "ignored-archive"),
      },
      () => {
        process.chdir(baseDir);
        const config = loadConfig();
        assert.equal(config.server.bind, "0.0.0.0");
        assert.equal(config.server.port, 9999);
        assert.equal(config.server.publicBaseUrl, "https://patchrelay.example.com");
        assert.equal(config.server.readinessPath, "/ready");
        assert.equal(config.logging.filePath, path.join(baseDir, "runtime.log"));
        assert.equal(config.logging.webhookArchiveDir, path.join(baseDir, "runtime-archive"));
        assert.equal(config.database.path, path.join(baseDir, "runtime.sqlite"));
        assert.equal(config.linear.webhookSecret, "top-secret");
        assert.equal(config.linear.tokenEncryptionKey, "enc-secret");
        assert.equal(config.linear.oauth.clientId, "oauth-client-id");
        assert.equal(config.linear.oauth.clientSecret, "oauth-client-secret");
        assert.equal(config.operatorApi.enabled, true);
        assert.equal(config.operatorApi.bearerToken, "operator-secret");
        assert.equal(config.projects[0]?.repoPath, path.join(baseDir, "repo"));
        assert.equal(config.projects[0]?.worktreeRoot, path.join(baseDir, "worktrees"));
        assert.equal(config.projects[0]?.workflowFiles.review, path.join(baseDir, "repo", "REVIEW.md"));
        assert.deepEqual(config.projects[0]?.trustedActors, {
          ids: ["user_123"],
          names: [],
          emails: ["owner@example.com"],
          emailDomains: ["example.com"],
        });
        assert.equal(config.runner.codex.shellBin, "/bin/bash");
        assert.equal(config.runner.codex.sourceBashrc, true);
      },
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig defaults to the XDG config path when PATCHRELAY_CONFIG is unset", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-xdg-"));
  const configHome = path.join(baseDir, "config-home");
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");
  const configPath = path.join(configHome, "patchrelay", "patchrelay.yaml");

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(
      configPath,
      `
server:
  bind: 127.0.0.1
  port: 8787
ingress:
  linear_webhook_path: /webhooks/linear
  max_body_bytes: 262144
  max_timestamp_skew_seconds: 60
logging:
  file_path: ${JSON.stringify(path.join(baseDir, "patchrelay.log"))}
database:
  path: ${JSON.stringify(path.join(baseDir, "patchrelay.sqlite"))}
linear:
  webhook_secret_env: REQUIRED_SECRET
${oauthConfigYaml}
projects:
  - id: usertold
    repo_path: ${JSON.stringify(repoPath)}
    worktree_root: ${JSON.stringify(worktreeRoot)}
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: undefined,
        XDG_CONFIG_HOME: configHome,
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.projects[0]?.repoPath, repoPath);
        assert.equal(config.projects[0]?.workflowFiles.development, path.join(repoPath, "IMPLEMENTATION_WORKFLOW.md"));
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig merges global workflow defaults with sparse project overrides", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-defaults-"));
  const repoPath = path.join(baseDir, "repo-one");
  const worktreeRoot = path.join(baseDir, "worktrees-one");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
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
${oauthConfigYaml}
defaults:
  workflow_files:
    deploy: automation/DEPLOY.md
    cleanup: automation/CLEANUP.md
  workflow_statuses:
    deploy: Release
    deploy_active: Releasing
    cleanup: Wrap Up
    done: Completed
projects:
  - id: one
    repo_path: ${repoPath}
    worktree_root: ${worktreeRoot}
    workflow_files:
      review: custom/REVIEW.md
    workflow_statuses:
      review: QA Review
      review_active: In QA
    trigger_events: [statusChanged]
    branch_prefix: one
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.deepEqual(config.projects[0]?.workflowFiles, {
          development: path.join(repoPath, "IMPLEMENTATION_WORKFLOW.md"),
          review: path.join(repoPath, "custom", "REVIEW.md"),
          deploy: path.join(repoPath, "automation", "DEPLOY.md"),
          cleanup: path.join(repoPath, "automation", "CLEANUP.md"),
        });
        assert.deepEqual(config.projects[0]?.workflowStatuses, {
          development: "Start",
          review: "QA Review",
          deploy: "Release",
          developmentActive: "Implementing",
          reviewActive: "In QA",
          deployActive: "Releasing",
          cleanup: "Wrap Up",
          cleanupActive: "Cleaning Up",
          humanNeeded: "Human Needed",
          done: "Completed",
        });
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig merges workflow defaults with sparse project overrides", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-defaults-"));
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
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
${oauthConfigYaml}
defaults:
  workflow_files:
    review: workflows/REVIEW.md
  workflow_statuses:
    review: Peer Review
    cleanup: Cleanup
    cleanup_active: Cleaning
    human_needed: Needs Human
projects:
  - id: usertold
    repo_path: ${repoPath}
    worktree_root: ${worktreeRoot}
    workflow_files:
      deploy: ops/DEPLOY.md
    workflow_statuses:
      deploy: Release
      cleanup: null
      human_needed: Escalate
      done: Shipped
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.projects[0]?.workflowFiles.development, path.join(repoPath, "IMPLEMENTATION_WORKFLOW.md"));
        assert.equal(config.projects[0]?.workflowFiles.review, path.join(repoPath, "workflows", "REVIEW.md"));
        assert.equal(config.projects[0]?.workflowFiles.deploy, path.join(repoPath, "ops", "DEPLOY.md"));
        assert.equal(config.projects[0]?.workflowFiles.cleanup, path.join(repoPath, "CLEANUP_WORKFLOW.md"));
        assert.equal(config.projects[0]?.workflowStatuses.development, "Start");
        assert.equal(config.projects[0]?.workflowStatuses.review, "Peer Review");
        assert.equal(config.projects[0]?.workflowStatuses.deploy, "Release");
        assert.equal(config.projects[0]?.workflowStatuses.cleanup, undefined);
        assert.equal(config.projects[0]?.workflowStatuses.cleanupActive, undefined);
        assert.equal(config.projects[0]?.workflowStatuses.humanNeeded, "Escalate");
        assert.equal(config.projects[0]?.workflowStatuses.done, "Shipped");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig rejects OAuth redirect URIs with a nonstandard callback path", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-oauth-path-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(path.join(baseDir, "repo"), { recursive: true });
    mkdirSync(path.join(baseDir, "worktrees"), { recursive: true });
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
  token_encryption_key_env: PATCHRELAY_TOKEN_ENCRYPTION_KEY
  oauth:
    client_id_env: LINEAR_OAUTH_CLIENT_ID
    client_secret_env: LINEAR_OAUTH_CLIENT_SECRET
    redirect_uri: https://patchrelay.example.com/not-the-fixed-path
    scopes: [read, write]
    actor: app
projects:
  - id: usertold
    repo_path: ./repo
    worktree_root: ./worktrees
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        assert.throws(
          () => loadConfig(),
          /linear\.oauth\.redirect_uri must use the fixed "\/oauth\/linear\/callback" path/,
        );
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig applies built-in workflow conventions when workflow settings are omitted", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-conventions-"));
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
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
${oauthConfigYaml}
projects:
  - id: usertold
    repo_path: ${repoPath}
    worktree_root: ${worktreeRoot}
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.deepEqual(config.projects[0]?.workflowFiles, {
          development: path.join(repoPath, "IMPLEMENTATION_WORKFLOW.md"),
          review: path.join(repoPath, "REVIEW_WORKFLOW.md"),
          deploy: path.join(repoPath, "DEPLOY_WORKFLOW.md"),
          cleanup: path.join(repoPath, "CLEANUP_WORKFLOW.md"),
        });
        assert.deepEqual(config.projects[0]?.workflowStatuses, {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          developmentActive: "Implementing",
          reviewActive: "Reviewing",
          deployActive: "Deploying",
          cleanup: "Cleanup",
          cleanupActive: "Cleaning Up",
          humanNeeded: "Human Needed",
          done: "Done",
        });
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig lets projects disable optional workflow statuses with null", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-disable-statuses-"));
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
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
${oauthConfigYaml}
defaults:
  workflow_statuses:
    cleanup: Cleanup
    cleanup_active: Cleaning Up
    human_needed: Human Needed
projects:
  - id: one
    repo_path: ${repoPath}
    worktree_root: ${worktreeRoot}
    workflow_statuses:
      cleanup: null
      cleanup_active: null
      human_needed: null
    trigger_events: [statusChanged]
    branch_prefix: one
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.projects[0]?.workflowStatuses.cleanup, undefined);
        assert.equal(config.projects[0]?.workflowStatuses.cleanupActive, undefined);
        assert.equal(config.projects[0]?.workflowStatuses.humanNeeded, undefined);
        assert.equal(config.projects[0]?.workflowStatuses.done, "Done");
      },
    );
  } finally {
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
${oauthConfigYaml}
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
        ...oauthEnv,
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
${oauthConfigYaml}
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
        ...oauthEnv,
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

test("loadConfig supports trusted actor names and domains", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-trust-"));

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
${oauthConfigYaml}
projects:
  - id: one
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
    trusted_actors:
      names: [Owner Name]
      email_domains: [trusted.example]
    trigger_events: [statusChanged]
    branch_prefix: use
`,
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.yaml"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.deepEqual(config.projects[0]?.trustedActors, {
          ids: [],
          names: ["Owner Name"],
          emails: [],
          emailDomains: ["trusted.example"],
        });
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
${oauthConfigYaml}
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
        ...oauthEnv,
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
