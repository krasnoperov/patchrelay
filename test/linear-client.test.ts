import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { DatabaseBackedLinearClientProvider, LinearGraphqlClient } from "../src/linear-client.ts";
import { decryptSecret, encryptSecret } from "../src/token-crypto.ts";
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

test("LinearGraphqlClient sends Bearer auth for access tokens", async () => {
  const originalFetch = globalThis.fetch;
  let seenAuthorization = "";

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seenAuthorization = String((init?.headers as Record<string, string>)?.authorization ?? "");
    return new Response(
      JSON.stringify({
        data: {
          issue: {
            id: "issue_1",
            state: { id: "start", name: "Start" },
            labels: { nodes: [] },
            team: { states: { nodes: [] }, labels: { nodes: [] } },
          },
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  }) as typeof fetch;

  try {
    const client = new LinearGraphqlClient(
      {
        accessToken: "secret-token",
        graphqlUrl: "https://linear.example/graphql",
      },
      pino({ enabled: false }),
    );

    await client.getIssue("issue_1");
    assert.equal(seenAuthorization, "Bearer secret-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LinearGraphqlClient surfaces HTTP and GraphQL failures", async () => {
  const originalFetch = globalThis.fetch;
  const client = new LinearGraphqlClient(
    {
      accessToken: "secret-token",
      graphqlUrl: "https://linear.example/graphql",
    },
    pino({ enabled: false }),
  );

  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
  try {
    await assert.rejects(() => client.getIssue("issue_1"), /Linear API request failed with HTTP 500/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ errors: [{ message: "forbidden" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(() => client.getIssue("issue_1"), /forbidden/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LinearGraphqlClient validates state changes and falls back from comment update to create", async () => {
  const originalFetch = globalThis.fetch;
  const responses = [
    {
      data: {
        issue: {
          id: "issue_1",
          identifier: "PR-1",
          state: { id: "state_1", name: "Todo" },
          labels: { nodes: [] },
          team: {
            states: { nodes: [{ id: "state_1", name: "Todo" }, { id: "state_2", name: "Done" }] },
            labels: { nodes: [] },
          },
        },
      },
    },
    {
      data: {
        commentUpdate: {
          success: false,
          comment: null,
        },
      },
    },
    {
      data: {
        commentCreate: {
          success: true,
          comment: { id: "comment_2", body: "new body" },
        },
      },
    },
  ];

  globalThis.fetch = (async () =>
    new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const client = new LinearGraphqlClient(
      {
        accessToken: "secret-token",
        graphqlUrl: "https://linear.example/graphql",
      },
      pino({ enabled: false }),
    );

    await assert.rejects(() => client.setIssueState("issue_1", "Missing"), /Linear state "Missing" was not found/);

    const comment = await client.upsertIssueComment({
      issueId: "issue_1",
      commentId: "comment_1",
      body: "new body",
    });

    assert.deepEqual(comment, { id: "comment_2", body: "new body" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LinearGraphqlClient updates only matching labels and skips missing ones", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: string[] = [];

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    requestBodies.push(body);
    if (requestBodies.length === 1) {
      return new Response(
        JSON.stringify({
          data: {
            issue: {
              id: "issue_1",
              identifier: "PR-1",
              state: { id: "state_1", name: "Todo" },
              labels: { nodes: [{ id: "label_a", name: "keep" }] },
              team: {
                labels: {
                  nodes: [
                    { id: "label_a", name: "keep" },
                    { id: "label_b", name: "ship" },
                  ],
                },
                states: { nodes: [] },
              },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: "issue_1",
              identifier: "PR-1",
              state: { id: "state_1", name: "Todo" },
              labels: { nodes: [{ id: "label_b", name: "ship" }] },
              team: {
                labels: {
                  nodes: [
                    { id: "label_a", name: "keep" },
                    { id: "label_b", name: "ship" },
                  ],
                },
                states: { nodes: [] },
              },
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const client = new LinearGraphqlClient(
      {
        accessToken: "secret-token",
        graphqlUrl: "https://linear.example/graphql",
      },
      pino({ enabled: false }),
    );

    const issue = await client.updateIssueLabels({
      issueId: "issue_1",
      addNames: ["ship", "missing"],
      removeNames: ["keep"],
    });

    assert.deepEqual(issue.labelIds, ["label_b"]);
    assert.match(requestBodies[1] ?? "", /label_b/);
    assert.match(requestBodies[1] ?? "", /label_a/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("DatabaseBackedLinearClientProvider refreshes expiring tokens and returns a working client", async () => {
  const originalFetch = globalThis.fetch;
  const config = createConfig();
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchrelay-linear-client-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.runMigrations();

  const installation = db.linearInstallations.upsertLinearInstallation({
    workspaceId: "team-1",
    workspaceName: "Workspace One",
    accessTokenCiphertext: encryptSecret("stale-access-token", config.linear.tokenEncryptionKey),
    refreshTokenCiphertext: encryptSecret("refresh-token", config.linear.tokenEncryptionKey),
    scopesJson: JSON.stringify(["read"]),
    expiresAt: new Date(Date.now() + 60 * 1000).toISOString(),
  });
  db.linearInstallations.linkProjectInstallation("project-1", installation.id);

  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
          scope: "read write",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    assert.equal(String((init?.headers as Record<string, string>)?.authorization ?? ""), "Bearer fresh-access-token");
    return new Response(
      JSON.stringify({
        data: {
          viewer: { id: "viewer-1", name: "Ada" },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const provider = new DatabaseBackedLinearClientProvider(config, db, pino({ enabled: false }));
    const client = await provider.forProject("project-1");

    assert.ok(client);
    const actor = await client!.getActorProfile();
    assert.deepEqual(actor, { actorId: "viewer-1", actorName: "Ada" });

    const updated = db.linearInstallations.getLinearInstallation(installation.id)!;
    assert.equal(decryptSecret(updated.accessTokenCiphertext, config.linear.tokenEncryptionKey), "fresh-access-token");
    assert.equal(decryptSecret(updated.refreshTokenCiphertext!, config.linear.tokenEncryptionKey), "fresh-refresh-token");
    assert.equal(JSON.parse(updated.scopesJson)[1], "write");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
