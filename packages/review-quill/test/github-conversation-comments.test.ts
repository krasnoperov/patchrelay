import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github-client.ts";

test("listPullRequestConversationComments reads issue comments with trust metadata", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input) => {
    const requestedUrl = String(input);
    requestedUrls.push(requestedUrl);
    const page = requestedUrl.endsWith("page=1")
      ? Array.from({ length: 100 }, (_, index) => ({
        id: index + 1,
        body: `Context ${index + 1}`,
        user: { login: "change-author[bot]" },
        author_association: "OWNER",
        created_at: "2026-07-18T10:01:00Z",
      }))
      : [{
      id: 17,
      body: "Updated product boundary",
      user: { login: "change-author[bot]" },
      author_association: "OWNER",
      created_at: "2026-07-18T10:02:00Z",
    }];
    return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  try {
    const client = new GitHubClient({ currentTokenForRepo: () => "token" });
    const comments = await client.listPullRequestConversationComments("owner/repo", 42);

    assert.deepEqual(requestedUrls.map((url) => new URL(url).searchParams.get("page")), ["1", "2"]);
    assert.equal(comments.length, 101);
    assert.deepEqual(comments.at(-1), {
      id: 17,
      body: "Updated product boundary",
      authorLogin: "change-author[bot]",
      authorAssociation: "OWNER",
      createdAt: "2026-07-18T10:02:00Z",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
