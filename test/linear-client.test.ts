import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { LinearGraphqlClient } from "../src/linear-client.ts";

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
