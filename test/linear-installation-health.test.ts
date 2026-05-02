import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { InstallationWebhookHandler } from "../src/webhook-installation-handler.ts";
import { DatabaseBackedLinearClientProvider } from "../src/linear-client.ts";
import { encryptSecret } from "../src/token-crypto.ts";
import type { AppConfig, NormalizedEvent } from "../src/types.ts";

function createConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 3000,
      publicBaseUrl: "https://patchrelay.example.com",
      healthPath: "/healthz",
      readinessPath: "/readyz",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 1024 * 1024,
      maxTimestampSkewSeconds: 300,
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
      webhookSecret: "webhook-secret",
      graphqlUrl: "https://linear.example/graphql",
      tokenEncryptionKey: "token-encryption-key",
      oauth: {
        clientId: "linear-client-id",
        clientSecret: "client-secret",
        redirectUri: "https://patchrelay.example.com/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "app",
      },
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: [],
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
        linearTeamIds: ["team-removed"],
        allowLabels: [],
        triggerEvents: ["agentSessionCreated"],
        branchPrefix: "use",
      },
    ],
  };
}

function createDatabase(config: AppConfig): PatchRelayDatabase {
  const db = new PatchRelayDatabase(config.database.path, config.database.wal);
  db.runMigrations();
  return db;
}

test("installation permission webhooks mark matched Linear installation health", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchrelay-linear-health-permissions-"));
  try {
    const config = createConfig(baseDir);
    const db = createDatabase(config);
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "org-1",
      workspaceName: "Workspace One",
      actorId: "app-user-1",
      accessTokenCiphertext: encryptSecret("access-token", config.linear.tokenEncryptionKey),
      scopesJson: JSON.stringify(["read", "write"]),
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    const handler = new InstallationWebhookHandler(config, { linearInstallations: db.linearInstallations }, pino({ enabled: false }));
    handler.handle({
      webhookId: "delivery-permissions",
      entityType: "PermissionChange",
      action: "teamAccessChanged",
      triggerEvent: "installationPermissionsChanged",
      eventType: "PermissionChange.teamAccessChanged",
      installation: {
        organizationId: "org-1",
        oauthClientId: "linear-client-id",
        appUserId: "app-user-1",
        canAccessAllPublicTeams: false,
        addedTeamIds: [],
        removedTeamIds: ["team-removed"],
      },
      payload: { action: "teamAccessChanged", type: "PermissionChange", createdAt: new Date().toISOString(), webhookTimestamp: Date.now() },
    } satisfies NormalizedEvent);

    const updated = db.linearInstallations.getLinearInstallation(installation.id);
    assert.equal(updated?.healthStatus, "permissions_changed");
    assert.match(updated?.healthReason ?? "", /team-removed/);
    assert.match(updated?.healthReason ?? "", /usertold/);
    assert.ok(updated?.healthUpdatedAt);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("revocation webhooks mark installations revoked and provider withholds clients", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchrelay-linear-health-revoked-"));
  try {
    const config = createConfig(baseDir);
    const db = createDatabase(config);
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "org-1",
      workspaceName: "Workspace One",
      actorId: "app-user-1",
      accessTokenCiphertext: encryptSecret("access-token", config.linear.tokenEncryptionKey),
      scopesJson: JSON.stringify(["read", "write"]),
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    const handler = new InstallationWebhookHandler(config, { linearInstallations: db.linearInstallations }, pino({ enabled: false }));
    handler.handle({
      webhookId: "delivery-revoked",
      entityType: "OAuthApp",
      action: "revoked",
      triggerEvent: "installationRevoked",
      eventType: "OAuthApp.revoked",
      installation: {
        organizationId: "org-1",
        oauthClientId: "linear-client-id",
        addedTeamIds: [],
        removedTeamIds: [],
      },
      payload: { action: "revoked", type: "OAuthApp", createdAt: new Date().toISOString(), webhookTimestamp: Date.now() },
    } satisfies NormalizedEvent);

    const updated = db.linearInstallations.getLinearInstallation(installation.id);
    assert.equal(updated?.healthStatus, "revoked");
    assert.match(updated?.healthReason ?? "", /revoked/);

    const provider = new DatabaseBackedLinearClientProvider(config, db, pino({ enabled: false }));
    assert.equal(await provider.forProject("usertold"), undefined);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("OAuth refresh failures mark Linear installation auth health", async () => {
  const originalFetch = globalThis.fetch;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchrelay-linear-health-auth-"));
  try {
    const config = createConfig(baseDir);
    const db = createDatabase(config);
    const installation = db.linearInstallations.upsertLinearInstallation({
      workspaceId: "org-1",
      workspaceName: "Workspace One",
      accessTokenCiphertext: encryptSecret("stale-access-token", config.linear.tokenEncryptionKey),
      refreshTokenCiphertext: encryptSecret("refresh-token", config.linear.tokenEncryptionKey),
      scopesJson: JSON.stringify(["read"]),
      expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
    });
    db.linearInstallations.linkProjectInstallation("usertold", installation.id);

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const provider = new DatabaseBackedLinearClientProvider(config, db, pino({ enabled: false }));
    await assert.rejects(() => provider.forProject("usertold"), /Linear OAuth token refresh failed with HTTP 401/);

    const updated = db.linearInstallations.getLinearInstallation(installation.id);
    assert.equal(updated?.healthStatus, "auth_error");
    assert.match(updated?.healthReason ?? "", /HTTP 401/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
