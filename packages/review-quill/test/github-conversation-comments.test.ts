import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github-client.ts";

test("listPullRequestConversationComments reads issue comments with trust metadata", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify([{
      id: 17,
      body: "Updated product boundary",
      user: { login: "change-author[bot]" },
      author_association: "OWNER",
      created_at: "2026-07-18T10:02:00Z",
    }]), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  try {
    const client = new GitHubClient({ currentTokenForRepo: () => "token" });
    const comments = await client.listPullRequestConversationComments("owner/repo", 42);

    assert.match(requestedUrl, /\/repos\/owner\/repo\/issues\/42\/comments\?per_page=100$/);
    assert.deepEqual(comments, [{
      id: 17,
      body: "Updated product boundary",
      authorLogin: "change-author[bot]",
      authorAssociation: "OWNER",
      createdAt: "2026-07-18T10:02:00Z",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
