import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { createGitHubAppTokenManager, resolveGitHubAuthConfig } from "../src/github-auth.ts";

test("resolveGitHubAuthConfig resolves GitHub App credentials", () => {
  const auth = resolveGitHubAuthConfig({
    REVIEW_QUILL_GITHUB_APP_ID: "123",
    REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY: "pem-value",
  });

  assert.equal(auth.mode, "app");
  if (auth.mode !== "app") return;
  assert.equal(auth.credentials.appId, "123");
  assert.equal(auth.credentials.privateKey, "pem-value");
});

function testPrivateKey(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
}

interface PlannedResponse {
  status: number;
  body: Record<string, unknown>;
}

class FetchStub {
  public calls: Array<{ url: string; method: string }> = [];
  constructor(private readonly plan: PlannedResponse[]) {}

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    this.calls.push({ url, method });
    const next = this.plan.shift();
    if (!next) throw new Error(`FetchStub ran out of responses at ${method} ${url}`);
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json" },
    });
  };
}

async function withFetchStub<T>(stub: FetchStub, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub.handler as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function silentLogger() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() { return this; },
  };
}

test("GitHub App token manager refreshes on start and on demand", async () => {
  const stub = new FetchStub([
    {
      status: 201,
      body: { token: "startup-token", expires_at: "2999-01-01T00:00:00Z" },
    },
    {
      status: 201,
      body: { token: "demand-token", expires_at: "2999-01-01T00:00:00Z" },
    },
  ]);

  await withFetchStub(stub, async () => {
    const manager = createGitHubAppTokenManager({
      appId: "123",
      privateKey: testPrivateKey(),
      installationId: "42",
    }, ["owner/repo"], silentLogger() as never);
    await manager.start();
    try {
      assert.equal(manager.currentTokenForRepo("owner/repo"), "startup-token");
      await manager.refreshTokenForRepo("owner/repo", "manual");
      assert.equal(manager.currentTokenForRepo("owner/repo"), "demand-token");
      const status = manager.authStatus();
      assert.equal(status.ready, true);
      assert.equal(status.lastRefreshError, null);
      assert.equal(status.installations[0]?.installationId, "42");
      assert.equal(status.installations[0]?.fresh, true);
    } finally {
      manager.stop();
    }
  });

  assert.deepEqual(stub.calls.map((call) => call.method), ["POST", "POST"]);
  assert.ok(stub.calls.every((call) => call.url.endsWith("/app/installations/42/access_tokens")));
});

test("GitHub App token manager records refresh failures without exposing secrets", async () => {
  const privateKey = testPrivateKey();
  const stub = new FetchStub([
    {
      status: 201,
      body: { token: "startup-token", expires_at: "2999-01-01T00:00:00Z" },
    },
    {
      status: 500,
      body: { message: "server unhappy" },
    },
  ]);

  await withFetchStub(stub, async () => {
    const manager = createGitHubAppTokenManager({
      appId: "123",
      privateKey,
      installationId: "42",
    }, ["owner/repo"], silentLogger() as never);
    await manager.start();
    try {
      await assert.rejects(manager.refreshTokenForRepo("owner/repo", "manual"), /GitHub API 500/);
      manager.recordAuthFailure("owner/repo", "Bad credentials");
      const status = manager.authStatus();
      assert.equal(status.ready, false);
      assert.match(status.lastRefreshError ?? "", /server unhappy/);
      assert.equal(status.recentAuthFailureCount, 1);
      assert.doesNotMatch(JSON.stringify(status), /startup-token|BEGIN RSA PRIVATE KEY/);
      assert.doesNotMatch(JSON.stringify(status), new RegExp(RegExp.escape(privateKey.slice(0, 40))));
    } finally {
      manager.stop();
    }
  });
});
