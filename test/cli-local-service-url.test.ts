import assert from "node:assert/strict";
import test from "node:test";
import { fetchLocalService, localServiceBaseUrl, normalizeLocalServiceHost } from "../src/cli/local-service-url.ts";
import type { AppConfig } from "../src/types.ts";

function configWithBind(bind: string): AppConfig {
  return {
    server: {
      bind,
      port: 8787,
      publicBaseUrl: "https://patchrelay.example.com",
      healthPath: "/health",
      readinessPath: "/ready",
    },
  } as AppConfig;
}

test("local service URL prefers localhost for loopback and wildcard binds", () => {
  assert.equal(normalizeLocalServiceHost("127.0.0.1"), "localhost");
  assert.equal(normalizeLocalServiceHost("0.0.0.0"), "localhost");
  assert.equal(normalizeLocalServiceHost("::"), "localhost");
  assert.equal(normalizeLocalServiceHost("::1"), "[::1]");
  assert.equal(normalizeLocalServiceHost("2001:db8::1"), "[2001:db8::1]");
  assert.equal(normalizeLocalServiceHost("10.1.2.3"), "10.1.2.3");
  assert.equal(localServiceBaseUrl(configWithBind("127.0.0.1")), "http://localhost:8787");
});

test("local service fetch retries transient probe failures", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => {
    calls += 1;
    if (calls === 1) {
      throw new Error("first probe timed out");
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const response = await fetchLocalService("http://localhost:8787/health", { retryDelayMs: 1 });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
