import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runPreflight } from "../src/preflight.ts";
import type { AppConfig } from "../src/types.ts";


function writeWorkflowFiles(config: AppConfig): void {
  for (const workflow of config.projects[0].workflows) {
    writeFileSync(workflow.workflowFile, `# ${workflow.id}\n`, "utf8");
  }
}

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
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
      filePath: path.join(baseDir, "logs", "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "data", "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
      },
      tokenEncryptionKey: "test-encryption-key",
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "node",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
      },
    },
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
  };
}

test("runPreflight reports a healthy local setup", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });
    writeWorkflowFiles(config);

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
    assert.ok(report.checks.some((check) => check.scope === "git" && check.status === "pass"));
    assert.ok(report.checks.some((check) => check.scope === "codex" && check.status === "pass"));
    assert.ok(report.checks.some((check) => check.scope === "public_url" && check.status === "pass"));
    assert.ok(report.checks.some((check) => check.scope === "database_schema" && check.status === "pass"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runPreflight fails when workflow files are missing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-missing-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });

    const report = await runPreflight(config);

    assert.equal(report.ok, false);
    assert.ok(
      report.checks.some(
        (check) =>
          check.scope === "project:usertold:workflow:default:development" &&
          check.status === "fail",
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runPreflight warns when the public base URL is missing", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-public-url-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });
    writeWorkflowFiles(config);
    delete config.server.publicBaseUrl;

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
    assert.ok(
      report.checks.some(
        (check) =>
          check.scope === "public_url" &&
          check.status === "warn" &&
          check.message.includes("server.public_base_url is not configured"),
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runPreflight warns when no projects are configured yet", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-no-projects-"));

  try {
    const config = createConfig(baseDir);
    config.projects = [];

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
    assert.ok(
      report.checks.some(
        (check) => check.scope === "projects" && check.status === "warn" && check.message.includes("No projects are configured yet"),
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runPreflight does not require cleanup workflow files when cleanup is disabled", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-no-cleanup-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });
    config.projects[0].workflows = config.projects[0].workflows.filter((workflow) => workflow.id !== "cleanup");
    writeWorkflowFiles(config);

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
    assert.ok(report.checks.every((check) => check.scope !== "project:usertold:workflow:cleanup"));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runPreflight warns when app-mode projects omit agent-session triggers", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-agent-triggers-"));

  try {
    const config = createConfig(baseDir);
    config.linear.oauth.actor = "app";
    config.linear.oauth.scopes = ["read", "write", "app:assignable", "app:mentionable"];
    mkdirSync(config.projects[0].repoPath, { recursive: true });
    writeWorkflowFiles(config);

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
    assert.ok(
      report.checks.some(
        (check) =>
          check.scope === "project:usertold:triggers" &&
          check.status === "warn" &&
          check.message.includes("delegateChanged"),
      ),
    );
    assert.ok(
      report.checks.some(
        (check) =>
          check.scope === "project:usertold:triggers" &&
          check.status === "warn" &&
          check.message.includes("agentSessionCreated"),
      ),
    );
    assert.ok(
      report.checks.some(
        (check) =>
          check.scope === "project:usertold:triggers" &&
          check.status === "warn" &&
          check.message.includes("agentPrompted"),
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("runPreflight fails when the configured database path cannot host a SQLite schema", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-db-schema-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });
    writeWorkflowFiles(config);
    mkdirSync(config.database.path, { recursive: true });

    const report = await runPreflight(config);

    assert.equal(report.ok, false);
    assert.ok(
      report.checks.some(
        (check) =>
          check.scope === "database_schema" &&
          check.status === "fail" &&
          check.message.includes("Unable to open or validate database schema"),
      ),
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
