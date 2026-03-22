import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
// buildRunningStatusComment removed — status comments replaced by agent activities
import { PatchRelayService } from "../src/service.ts";
import type { AppConfig } from "../src/types.ts";


function buildConfig(baseDir: string): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
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
      filePath: path.join(baseDir, "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
      wal: true,
    },
    linear: {
      webhookSecret: "webhook-secret",
      graphqlUrl: "https://api.linear.app/graphql",
      tokenEncryptionKey: "0123456789abcdef0123456789abcdef",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
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
        args: ["app-server"],
        sourceBashrc: false,
        serviceName: "patchrelay",
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

test("completeLinearOAuth rejects expired OAuth states and marks them failed", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-oauth-hardening-"));

  try {
    const config = buildConfig(baseDir);
    const db = new PatchRelayDatabase(config.database.path, config.database.wal);
    db.runMigrations();

    const oauthState = db.linearInstallations.createOAuthState({
      provider: "linear",
      state: "state-expired",
      projectId: "usertold",
      redirectUri: config.linear.oauth!.redirectUri,
      actor: config.linear.oauth!.actor,
    });
    db.connection
      .prepare("UPDATE oauth_states SET created_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 16 * 60 * 1000).toISOString(), oauthState.id);

    const codex = {
      on() {
        return undefined;
      },
    } as never;
    const service = new PatchRelayService(config, db, codex, undefined, pino({ enabled: false }));

    await assert.rejects(
      () => service.completeLinearOAuth({ state: oauthState.state, code: "oauth-code" }),
      /OAuth state has expired/,
    );

    const refreshed = db.linearInstallations.getOAuthState(oauthState.state);
    assert.equal(refreshed?.status, "failed");
    assert.equal(refreshed?.errorMessage, "OAuth state expired");
    assert.equal(Boolean(refreshed?.consumedAt), true);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

// Status comment test removed — status comments replaced by agent activities
