import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github-client.ts";

test("listIntegrationCandidateRefs reads every matching-refs page", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    requestedPages.push(url.searchParams.get("page") ?? "");
    const page = url.searchParams.get("page");
    const refs = page === "1"
      ? Array.from({ length: 100 }, (_, index) => ({
          ref: `refs/heads/merge-steward/main/pr-${index + 1}`,
          object: { sha: `candidate-${index + 1}` },
        }))
      : [{ ref: "refs/heads/merge-steward/main/pr-101", object: { sha: "candidate-101" } }];
    return new Response(JSON.stringify(refs), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;

  try {
    const client = new GitHubClient({ currentTokenForRepo: () => "token" });
    const refs = await client.listIntegrationCandidateRefs("owner/repo");
    assert.deepEqual(requestedPages, ["1", "2"]);
    assert.equal(refs.length, 101);
    assert.deepEqual(refs.at(-1), {
      ref: "refs/heads/merge-steward/main/pr-101",
      sha: "candidate-101",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
