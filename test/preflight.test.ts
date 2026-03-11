import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runPreflight } from "../src/preflight.ts";
import type { AppConfig } from "../src/types.ts";

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
        workflowFiles: {
          development: path.join(baseDir, "IMPLEMENTATION_WORKFLOW.md"),
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

test("runPreflight reports a healthy local setup", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-preflight-"));

  try {
    const config = createConfig(baseDir);
    mkdirSync(config.projects[0].repoPath, { recursive: true });
    writeFileSync(config.projects[0].workflowFiles.development, "# dev\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.review, "# review\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.deploy, "# deploy\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.cleanup, "# cleanup\n", "utf8");

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
    assert.ok(report.checks.some((check) => check.scope === "git" && check.status === "pass"));
    assert.ok(report.checks.some((check) => check.scope === "codex" && check.status === "pass"));
    assert.ok(report.checks.some((check) => check.scope === "public_url" && check.status === "pass"));
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
        (check) => check.scope === "project:usertold:workflow:development" && check.status === "fail",
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
    writeFileSync(config.projects[0].workflowFiles.development, "# dev\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.review, "# review\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.deploy, "# deploy\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.cleanup, "# cleanup\n", "utf8");
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
    writeFileSync(config.projects[0].workflowFiles.development, "# dev\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.review, "# review\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.deploy, "# deploy\n", "utf8");
    delete config.projects[0].workflowFiles.cleanup;
    delete config.projects[0].workflowStatuses.cleanup;
    delete config.projects[0].workflowStatuses.cleanupActive;

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
    writeFileSync(config.projects[0].workflowFiles.development, "# dev\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.review, "# review\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.deploy, "# deploy\n", "utf8");
    writeFileSync(config.projects[0].workflowFiles.cleanup, "# cleanup\n", "utf8");

    const report = await runPreflight(config);

    assert.equal(report.ok, true);
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
