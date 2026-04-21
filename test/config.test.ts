import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";
import { getPatchRelayDataDir } from "../src/runtime-paths.ts";

const oauthConfig = {
  token_encryption_key_env: "PATCHRELAY_TOKEN_ENCRYPTION_KEY",
  oauth: {
    client_id_env: "LINEAR_OAUTH_CLIENT_ID",
    client_secret_env: "LINEAR_OAUTH_CLIENT_SECRET",
    redirect_uri: "http://127.0.0.1:8787/oauth/linear/callback",
    scopes: ["read", "write"],
    actor: "user",
  },
} as const;

const oauthConfigWithoutRedirect = {
  token_encryption_key_env: "PATCHRELAY_TOKEN_ENCRYPTION_KEY",
  oauth: {
    client_id_env: "LINEAR_OAUTH_CLIENT_ID",
    client_secret_env: "LINEAR_OAUTH_CLIENT_SECRET",
    scopes: ["read", "write"],
    actor: "user",
  },
} as const;

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

function writeConfigFixture(configPath: string, value: unknown): void {
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("loadConfig expands env vars, resolves paths, and honors runtime overrides", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-"));
  const originalCwd = process.cwd();

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(path.join(baseDir, "repo"), { recursive: true });
    mkdirSync(path.join(baseDir, "worktrees"), { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "0.0.0.0",
        port: 9999,
        public_base_url: "https://patchrelay.example.com",
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "${LOG_FILE_PATH:-./logs/default.log}",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      operator_api: {
        enabled: true,
        bearer_token_env: "PATCHRELAY_OPERATOR_TOKEN",
      },
      projects: [
        {
          id: "usertold",
          repo_path: "./repo",
          worktree_root: "./worktrees",
          trusted_actors: {
            ids: ["user_123"],
            emails: ["owner@example.com"],
            email_domains: ["example.com"],
          },
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
      runner: {
        codex: {
          shell_bin: "/bin/bash",
          source_bashrc: true,
        },
      },
      linear: {
        webhook_secret_env: "CUSTOM_LINEAR_SECRET",
        ...oauthConfig,
      },
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        PATCHRELAY_LOG_FILE: path.join(baseDir, "runtime.log"),
        PATCHRELAY_DB_PATH: path.join(baseDir, "runtime.sqlite"),
        CUSTOM_LINEAR_SECRET: "top-secret",
        PATCHRELAY_OPERATOR_TOKEN: "operator-secret",
        ...oauthEnv,
        LOG_FILE_PATH: path.join(baseDir, "ignored.log"),
      },
      () => {
        process.chdir(baseDir);
        const config = loadConfig();
        assert.equal(config.server.bind, "0.0.0.0");
        assert.equal(config.server.port, 9999);
        assert.equal(config.server.publicBaseUrl, "https://patchrelay.example.com");
        assert.equal(config.server.readinessPath, "/ready");
        assert.equal(config.logging.filePath, path.join(baseDir, "runtime.log"));
        assert.equal(config.database.path, path.join(baseDir, "runtime.sqlite"));
        assert.equal(config.linear.webhookSecret, "top-secret");
        assert.equal(config.linear.tokenEncryptionKey, "enc-secret");
        assert.equal(config.linear.oauth.clientId, "oauth-client-id");
        assert.equal(config.linear.oauth.clientSecret, "oauth-client-secret");
        assert.equal(config.operatorApi.enabled, true);
        assert.equal(config.operatorApi.bearerToken, "operator-secret");
        assert.equal(config.projects[0]?.repoPath, path.join(baseDir, "repo"));
        assert.equal(config.projects[0]?.worktreeRoot, path.join(baseDir, "worktrees"));
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
  const configPath = path.join(configHome, "patchrelay", "patchrelay.json");

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(configPath, {
      server: {
        bind: "127.0.0.1",
        port: 8787,
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
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

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
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig resolves installation prompt files relative to the config file", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-prompting-"));
  const configDir = path.join(baseDir, "config");
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(configDir, { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    mkdirSync(path.join(configDir, "prompts"), { recursive: true });
    writeFileSync(path.join(configDir, "prompts", "local-policy.md"), "Install local policy\n");
    writeFileSync(path.join(configDir, "prompts", "publication.md"), "## Publish\n\nCustom publication\n");
    writeConfigFixture(path.join(configDir, "patchrelay.json"), {
      logging: { file_path: path.join(baseDir, "patchrelay.log") },
      database: { path: path.join(baseDir, "patchrelay.sqlite") },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      prompting: {
        default: {
          extra_instructions_file: "./prompts/local-policy.md",
          replace_sections: {
            "publication-contract": "./prompts/publication.md",
          },
        },
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(configDir, "patchrelay.json"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.prompting.default.extraInstructions?.content, "Install local policy");
        assert.equal(
          config.prompting.default.replaceSections["publication-contract"]?.content,
          "## Publish\n\nCustom publication",
        );
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig injects default PatchRelay developer instructions and appends local developer instructions", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-dev-instructions-"));
  const configPath = path.join(baseDir, "patchrelay.json");
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(configPath, {
      logging: { file_path: path.join(baseDir, "patchrelay.log") },
      database: { path: path.join(baseDir, "patchrelay.sqlite") },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      runner: {
        codex: {
          developer_instructions: "Always preserve the repo's public API shape.",
        },
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: configPath,
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.match(String(config.runner.codex.developerInstructions ?? ""), /You are PatchRelay's coding agent\./);
        assert.match(String(config.runner.codex.developerInstructions ?? ""), /For repair runs, work on the existing PR branch and do not open a new PR\./);
        assert.match(String(config.runner.codex.developerInstructions ?? ""), /If you change schema, enums, shared vocabulary, normalization helpers, or compatibility mappings, inspect the main read\/write paths that can bypass the new abstraction and fix or cover any mismatch before publishing\./);
        assert.match(String(config.runner.codex.developerInstructions ?? ""), /For CI repair, do not change code or config until you either reproduce the failure on the exact failing head or can point to a concrete log signature that justifies the fix\./);
        assert.match(String(config.runner.codex.developerInstructions ?? ""), /## Local Developer Instructions/);
        assert.match(String(config.runner.codex.developerInstructions ?? ""), /Always preserve the repo's public API shape\./);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig reads service secrets from the default adjacent service.env file", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-service-env-"));
  const configHome = path.join(baseDir, "config-home");
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");
  const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
  const serviceEnvPath = path.join(configHome, "patchrelay", "service.env");

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(configPath, {
      server: {
        bind: "127.0.0.1",
        port: 8787,
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });
    writeFileSync(
      serviceEnvPath,
      [
        "REQUIRED_SECRET=top-secret",
        "PATCHRELAY_TOKEN_ENCRYPTION_KEY=env-enc-secret",
        "LINEAR_OAUTH_CLIENT_ID=env-client-id",
        "LINEAR_OAUTH_CLIENT_SECRET=env-client-secret",
        "",
      ].join("\n"),
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: undefined,
        XDG_CONFIG_HOME: configHome,
        REQUIRED_SECRET: undefined,
        PATCHRELAY_TOKEN_ENCRYPTION_KEY: undefined,
        LINEAR_OAUTH_CLIENT_ID: undefined,
        LINEAR_OAUTH_CLIENT_SECRET: undefined,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.linear.webhookSecret, "top-secret");
        assert.equal(config.linear.tokenEncryptionKey, "env-enc-secret");
        assert.equal(config.linear.oauth.clientId, "env-client-id");
        assert.equal(config.linear.oauth.clientSecret, "env-client-secret");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig keeps local cli profile from reading service.env secrets", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-cli-no-service-env-"));
  const configHome = path.join(baseDir, "config-home");
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");
  const configPath = path.join(configHome, "patchrelay", "patchrelay.json");
  const serviceEnvPath = path.join(configHome, "patchrelay", "service.env");

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(configPath, {
      server: {
        bind: "127.0.0.1",
        port: 8787,
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });
    writeFileSync(
      serviceEnvPath,
      [
        "REQUIRED_SECRET=top-secret",
        "PATCHRELAY_TOKEN_ENCRYPTION_KEY=env-enc-secret",
        "LINEAR_OAUTH_CLIENT_ID=env-client-id",
        "LINEAR_OAUTH_CLIENT_SECRET=env-client-secret",
        "",
      ].join("\n"),
      "utf8",
    );

    withEnv(
      {
        PATCHRELAY_CONFIG: undefined,
        XDG_CONFIG_HOME: configHome,
        REQUIRED_SECRET: undefined,
        PATCHRELAY_TOKEN_ENCRYPTION_KEY: undefined,
        LINEAR_OAUTH_CLIENT_ID: undefined,
        LINEAR_OAUTH_CLIENT_SECRET: undefined,
      },
      () => {
        const config = loadConfig(undefined, { profile: "cli" });
        assert.equal(config.linear.webhookSecret, "");
        assert.equal(config.linear.tokenEncryptionKey, "");
        assert.equal(config.linear.oauth.clientId, "");
        assert.equal(config.linear.oauth.clientSecret, "");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});


test("loadConfig accepts machine-level config before any projects are added", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-machine-only-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        public_base_url: "https://relay.example.com",
      },
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        LINEAR_WEBHOOK_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.server.publicBaseUrl, "https://relay.example.com");
        assert.equal(config.projects.length, 0);
        assert.equal(config.runner.codex.bin, "codex");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig derives the OAuth redirect URI from server.public_base_url when redirect_uri is omitted", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-derived-public-oauth-"));
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "127.0.0.1",
        port: 8787,
        public_base_url: "https://patchrelay.example.com/ignored-path",
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfigWithoutRedirect,
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.linear.oauth.redirectUri, "https://patchrelay.example.com/oauth/linear/callback");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig derives the OAuth redirect URI from the local bind and port when no public URL is configured", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-derived-local-oauth-"));
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "0.0.0.0",
        port: 9999,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfigWithoutRedirect,
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.linear.oauth.redirectUri, "http://127.0.0.1:9999/oauth/linear/callback");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig applies default app-mode trigger events when trigger_events is omitted", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-default-triggers-"));
  const repoPath = path.join(baseDir, "repo");
  const worktreeRoot = path.join(baseDir, "worktrees");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    mkdirSync(worktreeRoot, { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "127.0.0.1",
        port: 8787,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        token_encryption_key_env: "PATCHRELAY_TOKEN_ENCRYPTION_KEY",
        oauth: {
          client_id_env: "LINEAR_OAUTH_CLIENT_ID",
          client_secret_env: "LINEAR_OAUTH_CLIENT_SECRET",
          actor: "app",
        },
      },
      projects: [
        {
          id: "usertold",
          repo_path: repoPath,
          worktree_root: worktreeRoot,
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.deepEqual(config.projects[0]?.triggerEvents, ["delegateChanged", "statusChanged", "agentSessionCreated", "agentPrompted", "commentCreated", "commentUpdated"]);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig derives project worktree_root and branch_prefix when omitted", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-project-defaults-"));
  const repoPath = path.join(baseDir, "repo");

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        public_base_url: "https://relay.example.com",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfigWithoutRedirect,
      },
      projects: [
        {
          id: "Usertold App",
          repo_path: repoPath,
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(
          config.projects[0]?.worktreeRoot,
          path.join(getPatchRelayDataDir(), "worktrees", "Usertold App"),
        );
        assert.equal(config.projects[0]?.branchPrefix, "usertold-app");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig derives runtime projects from repository-first config", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-repositories-"));
  const configPath = path.join(baseDir, "config", "patchrelay.json");
  const repoRoot = path.join(baseDir, "repos");
  const repoPath = path.join(repoRoot, "usertold");

  try {
    mkdirSync(path.dirname(configPath), { recursive: true });
    mkdirSync(repoPath, { recursive: true });
    writeConfigFixture(configPath, {
      server: {
        public_base_url: "https://patchrelay.example.com",
      },
      repos: {
        root: repoRoot,
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      repositories: [
        {
          github_repo: "krasnoperov/usertold",
          workspace: "usertold",
          local_path: repoPath,
          linear_team_ids: ["team-use"],
          linear_project_ids: ["project-site"],
          issue_key_prefixes: ["USE"],
          repair_budgets: {
            ci_repair: 7,
            queue_repair: 7,
            review_fix: 7,
          },
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: configPath,
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        const config = loadConfig();
        assert.equal(config.repos.root, repoRoot);
        assert.equal(config.repositories.length, 1);
        assert.equal(config.repositories[0]?.githubRepo, "krasnoperov/usertold");
        assert.equal(config.repositories[0]?.workspace, "usertold");
        assert.deepEqual(config.projects[0]?.repairBudgets, {
          ciRepair: 7,
          queueRepair: 7,
          reviewFix: 7,
        });
        assert.deepEqual(config.repositories[0]?.linearProjectIds, ["project-site"]);
        assert.equal(config.projects[0]?.id, "krasnoperov/usertold");
        assert.equal(config.projects[0]?.repoPath, repoPath);
        assert.deepEqual(config.projects[0]?.linearTeamIds, ["team-use"]);
        assert.equal(config.projects[0]?.github?.repoFullName, "krasnoperov/usertold");
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
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "127.0.0.1",
        port: 8787,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        token_encryption_key_env: "PATCHRELAY_TOKEN_ENCRYPTION_KEY",
        oauth: {
          client_id_env: "LINEAR_OAUTH_CLIENT_ID",
          client_secret_env: "LINEAR_OAUTH_CLIENT_SECRET",
          redirect_uri: "https://patchrelay.example.com/not-the-fixed-path",
          scopes: ["read", "write"],
          actor: "app",
        },
      },
      projects: [
        {
          id: "usertold",
          repo_path: "./repo",
          worktree_root: "./worktrees",
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
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



test("loadConfig rejects overlapping project routing and unsafe operator API exposure", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-overlap-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "0.0.0.0",
        port: 8787,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      operator_api: {
        enabled: true,
      },
      projects: [
        {
          id: "one",
          repo_path: "./repo-one",
          worktree_root: "./worktrees-one",
          issue_key_prefixes: ["USE"],
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
        {
          id: "two",
          repo_path: "./repo-two",
          worktree_root: "./worktrees-two",
          issue_key_prefixes: ["USE"],
          trigger_events: ["statusChanged"],
          branch_prefix: "use2",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
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
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "0.0.0.0",
        port: 8787,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      operator_api: {
        enabled: true,
      },
      projects: [
        {
          id: "usertold",
          repo_path: "./repo",
          worktree_root: "./worktrees",
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        REQUIRED_SECRET: "top-secret",
        ...oauthEnv,
      },
      () => {
        assert.throws(
          () => loadConfig(),
          /operator_api.enabled requires operator_api.bearer_token_env when server.bind is not 127.0.0.1/,
        );
        const config = loadConfig(undefined, { profile: "doctor" });
        assert.equal(config.operatorApi.enabled, true);
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
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "127.0.0.1",
        port: 8787,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      projects: [
        {
          id: "one",
          repo_path: "./repo",
          worktree_root: "./worktrees",
          trusted_actors: {
            names: ["Owner Name"],
            email_domains: ["trusted.example"],
          },
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
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

test("loadConfig only requires service secrets in the service profile", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-config-missing-secret-"));

  try {
    mkdirSync(path.join(baseDir, "config"), { recursive: true });
    writeConfigFixture(path.join(baseDir, "config", "patchrelay.json"), {
      server: {
        bind: "127.0.0.1",
        port: 8787,
      },
      ingress: {
        linear_webhook_path: "/webhooks/linear",
        max_body_bytes: 262144,
        max_timestamp_skew_seconds: 60,
      },
      logging: {
        file_path: "./patchrelay.log",
      },
      database: {
        path: "./data/patchrelay.sqlite",
      },
      linear: {
        webhook_secret_env: "REQUIRED_SECRET",
        ...oauthConfig,
      },
      projects: [
        {
          id: "usertold",
          repo_path: "./repo",
          worktree_root: "./worktrees",
          trigger_events: ["statusChanged"],
          branch_prefix: "use",
        },
      ],
      runner: {
        codex: {
          source_bashrc: false,
        },
      },
    });

    withEnv(
      {
        PATCHRELAY_CONFIG: path.join(baseDir, "config", "patchrelay.json"),
        REQUIRED_SECRET: undefined,
        ...oauthEnv,
      },
      () => {
        assert.throws(() => loadConfig(), /Missing env var REQUIRED_SECRET/);
        const config = loadConfig(undefined, { profile: "cli" });
        assert.equal(config.runner.codex.sourceBashrc, false);
        assert.equal(config.linear.webhookSecret, "");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
