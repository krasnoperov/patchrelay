import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import { LinearGraphqlClient } from "../src/linear-client.js";

test("LinearGraphqlClient sends raw API key auth", async () => {
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
        apiToken: "secret-token",
        graphqlUrl: "https://linear.example/graphql",
      },
      pino({ enabled: false }),
    );

    await client.getIssue("issue_1");
    assert.equal(seenAuthorization, "secret-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
