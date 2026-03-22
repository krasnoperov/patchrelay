import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import {
  createLinearOAuthUrl,
  createOAuthStateToken,
  exchangeLinearOAuthCode,
  fetchLinearViewerIdentity,
  installLinearOAuthCode,
  refreshLinearOAuthToken,
} from "../src/linear-oauth.ts";
import { decryptSecret } from "../src/token-crypto.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(): AppConfig {
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
      filePath: "/tmp/patchrelay.log",
    },
    database: {
      path: "/tmp/patchrelay.sqlite",
      wal: true,
    },
    linear: {
      webhookSecret: "webhook-secret",
      graphqlUrl: "https://linear.example/graphql",
      tokenEncryptionKey: "token-encryption-key",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://patchrelay.example.com/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
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
    projects: [],
  };
}

test("createOAuthStateToken returns a hex token and createLinearOAuthUrl includes expected params", () => {
  const config = createConfig();
  const state = createOAuthStateToken();

  assert.match(state, /^[0-9a-f]{48}$/);

  const url = new URL(createLinearOAuthUrl(config, state, "https://override.example/callback"));
  assert.equal(url.origin + url.pathname, "https://linear.app/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), config.linear.oauth.clientId);
  assert.equal(url.searchParams.get("redirect_uri"), "https://override.example/callback");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "read write");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("actor"), "user");
});

test("exchangeLinearOAuthCode and refreshLinearOAuthToken normalize successful responses", async () => {
  const originalFetch = globalThis.fetch;
  const config = createConfig();
  const calls: Array<{ url: string; body?: string }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(
      JSON.stringify({
        access_token: calls.length === 1 ? "access-1" : "access-2",
        refresh_token: "refresh-2",
        expires_in: 3600,
        scope: "read,write",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const exchanged = await exchangeLinearOAuthCode(config, {
      code: "oauth-code",
      redirectUri: "https://override.example/callback",
    });
    const refreshed = await refreshLinearOAuthToken(config, "refresh-token");

    assert.equal(exchanged.accessToken, "access-1");
    assert.equal(exchanged.refreshToken, "refresh-2");
    assert.deepEqual(exchanged.scopes, ["read", "write"]);
    assert.ok(exchanged.expiresAt);

    assert.equal(refreshed.accessToken, "access-2");
    assert.equal(refreshed.refreshToken, "refresh-2");
    assert.deepEqual(refreshed.scopes, ["read", "write"]);
    assert.ok(refreshed.expiresAt);

    assert.match(calls[0].body ?? "", /grant_type=authorization_code/);
    assert.match(calls[1].body ?? "", /grant_type=refresh_token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth helpers reject failed or malformed token responses", async () => {
  const originalFetch = globalThis.fetch;
  const config = createConfig();

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "bad_code" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => exchangeLinearOAuthCode(config, { code: "bad", redirectUri: config.linear.oauth.redirectUri }),
      /Linear OAuth code exchange failed with HTTP 401/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ refresh_token: "still-missing-access-token" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    await assert.rejects(() => refreshLinearOAuthToken(config, "refresh-token"), /did not include access_token/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchLinearViewerIdentity returns viewer and workspace details and rejects failed lookups", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: {
          viewer: { id: "viewer-1", name: "Ada" },
          teams: { nodes: [{ id: "team-1", name: "Workspace One", key: "W1" }] },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const identity = await fetchLinearViewerIdentity("https://linear.example/graphql", "access-token", pino({ enabled: false }));
    assert.deepEqual(identity, {
      workspaceId: "team-1",
      workspaceName: "Workspace One",
      workspaceKey: "W1",
      actorId: "viewer-1",
      actorName: "Ada",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ errors: [{ message: "forbidden" }] }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchLinearViewerIdentity("https://linear.example/graphql", "access-token", pino({ enabled: false })),
      /Linear viewer lookup failed with HTTP 403/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("installLinearOAuthCode stores encrypted credentials and links the project installation", async () => {
  const originalFetch = globalThis.fetch;
  const config = createConfig();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchrelay-linear-oauth-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();

  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          access_token: "installed-access-token",
          refresh_token: "installed-refresh-token",
          expires_in: 600,
          scope: "read write",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          viewer: { id: "viewer-1", name: "Ada" },
          teams: { nodes: [{ id: "team-1", name: "Workspace One", key: "W1" }] },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const installation = await installLinearOAuthCode({
      config,
      db: db.linearInstallations,
      logger: pino({ enabled: false }),
      code: "oauth-code",
      redirectUri: config.linear.oauth.redirectUri,
      projectId: "project-1",
    });

    assert.equal(installation.workspaceId, "team-1");
    assert.equal(installation.workspaceName, "Workspace One");
    assert.equal(installation.actorId, "viewer-1");
    assert.equal(installation.actorName, "Ada");
    assert.equal(decryptSecret(installation.accessTokenCiphertext, config.linear.tokenEncryptionKey), "installed-access-token");
    assert.equal(decryptSecret(installation.refreshTokenCiphertext!, config.linear.tokenEncryptionKey), "installed-refresh-token");
    assert.deepEqual(JSON.parse(installation.scopesJson), ["read", "write"]);

    const link = db.linearInstallations.getProjectInstallation("project-1");
    assert.equal(link?.installationId, installation.id);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
