import assert from "node:assert/strict";
import test from "node:test";
import { GitHubClient } from "../src/github-client.ts";
import { parseModelResponse } from "../src/review-runner.ts";

// A planned sequence of fetch responses. Each entry is consumed once,
// in order. Missing entries throw so tests fail loudly instead of
// silently re-using a response.
interface PlannedResponse {
  kind: "ok" | "error" | "throw";
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  errorMessage?: string;
}

class FetchStub {
  public calls: Array<{ url: string; method: string }> = [];
  constructor(private readonly plan: PlannedResponse[]) {}

  handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    this.calls.push({ url, method });
    const next = this.plan.shift();
    if (!next) {
      throw new Error(`FetchStub ran out of planned responses at call #${this.calls.length} (${method} ${url})`);
    }
    if (next.kind === "throw") {
      throw new Error(next.errorMessage ?? "simulated network failure");
    }
    const bodyText = next.body ?? (next.kind === "ok" ? "{}" : "server error");
    return new Response(bodyText, {
      status: next.status ?? (next.kind === "ok" ? 200 : 500),
      headers: next.headers ?? { "content-type": "application/json" },
    });
  };
}

// Swap global.fetch for the duration of a single call; restore in finally.
async function withFetchStub<T>(stub: FetchStub, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub.handler as typeof globalThis.fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function makeClient(): GitHubClient {
  return new GitHubClient({ currentTokenForRepo: () => "fake-token" });
}

// ---- HTTP retry layer tests --------------------------------------------

test("GitHubClient retries a GET on 503 and succeeds on the second attempt", async () => {
  const stub = new FetchStub([
    { kind: "error", status: 503, body: "overloaded" },
    { kind: "ok", status: 200, body: "[]" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    const result = await client.listOpenPullRequests("owner/repo");
    assert.deepEqual(result, []);
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]?.method, "GET");
    assert.equal(stub.calls[1]?.method, "GET");
  });
});

test("GitHubClient retries a GET up to 5 attempts and throws the last error", async () => {
  const retryNow = { "Retry-After": "0" };
  const stub = new FetchStub([
    { kind: "error", status: 500, body: "first", headers: retryNow },
    { kind: "error", status: 502, body: "second", headers: retryNow },
    { kind: "error", status: 503, body: "third", headers: retryNow },
    { kind: "error", status: 503, body: "fourth", headers: retryNow },
    { kind: "error", status: 503, body: "fifth", headers: retryNow },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await assert.rejects(
      client.listOpenPullRequests("owner/repo"),
      /GitHub API 503.*fifth/,
    );
    assert.equal(stub.calls.length, 5);
  });
});

test("GitHubClient compacts GitHub HTML outage pages in error messages", async () => {
  const html = `<!DOCTYPE html>
<!--
Hello future GitHubber! I bet you're here to remove those nasty inline styles,
DRY up these templates and make 'em nice and re-usable, right?
-->
<html>
  <head>
    <title>Unicorn! &middot; GitHub</title>
    <style>body { background: #f1f1f1; }</style>
  </head>
  <body>
    <p><img src="data:image/png;base64,${"a".repeat(2_000)}"></p>
    <p><strong>No server is currently available to service your request.</strong></p>
    <p>Sorry about that. Please try refreshing and contact us if the problem persists.</p>
  </body>
</html>`;
  const headers = { "content-type": "text/html; charset=utf-8", "Retry-After": "0" };
  const stub = new FetchStub([
    { kind: "error", status: 503, body: html, headers },
    { kind: "error", status: 503, body: html, headers },
    { kind: "error", status: 503, body: html, headers },
    { kind: "error", status: 503, body: html, headers },
    { kind: "error", status: 503, body: html, headers },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await assert.rejects(
      client.getPullRequest("owner/repo", 274),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /GitHub API 503/);
        assert.match(error.message, /HTML response: Unicorn! · GitHub/);
        assert.match(error.message, /No server is currently available/);
        assert.doesNotMatch(error.message, /future GitHubber/);
        assert.doesNotMatch(error.message, /base64/);
        assert.ok(error.message.length < 1_000, `message was ${error.message.length} chars`);
        return true;
      },
    );
    assert.equal(stub.calls.length, 5);
  });
});

test("GitHubClient does NOT retry a POST on 5xx (non-idempotent safety)", async () => {
  const stub = new FetchStub([
    { kind: "error", status: 502, body: "bad gateway" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await assert.rejects(
      client.submitReview("owner/repo", 1, {
        event: "APPROVE",
        body: "LGTM",
      }),
      /GitHub API 502/,
    );
    // Only ONE call — the 502 on a POST must not trigger a retry.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.method, "POST");
  });
});

test("GitHubClient DOES retry a POST on a network error before response", async () => {
  const stub = new FetchStub([
    { kind: "throw", errorMessage: "ECONNRESET" },
    { kind: "ok", status: 200, body: "{\"id\":123}" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    // submitReview returns void on success — if the retry didn't fire,
    // the ECONNRESET would propagate and this would reject.
    await client.submitReview("owner/repo", 1, {
      event: "APPROVE",
      body: "LGTM",
    });
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[0]?.method, "POST");
    assert.equal(stub.calls[1]?.method, "POST");
  });
});

test("GitHubClient honors Retry-After on a retryable GET 429", async () => {
  const startedAt = Date.now();
  const stub = new FetchStub([
    { kind: "error", status: 429, body: "rate limited", headers: { "Retry-After": "1" } },
    { kind: "ok", status: 200, body: "[]" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    const result = await client.listOpenPullRequests("owner/repo");
    assert.deepEqual(result, []);
  });
  const elapsed = Date.now() - startedAt;
  // The Retry-After header said 1 second. We should have waited at
  // least ~900ms (allow a small margin for timer coarseness).
  assert.ok(elapsed >= 900, `expected >=900ms elapsed for Retry-After=1, got ${elapsed}ms`);
});

test("GitHubClient propagates a 422 on submitReview without retrying (fallback is handled by the caller)", async () => {
  // 422 is a validation error — the server DID see the request, and
  // retrying the identical request would fail identically. The
  // service.ts caller catches 422 specifically and retries WITHOUT
  // inline comments as a fallback, but that retry is a fresh
  // submitReview call with a different payload, not an HTTP-level retry.
  const stub = new FetchStub([
    {
      kind: "error",
      status: 422,
      body: JSON.stringify({ message: "Pull request review comment on invalid line" }),
    },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await assert.rejects(
      client.submitReview("owner/repo", 1, {
        event: "REQUEST_CHANGES",
        body: "needs fixes",
        comments: [{ path: "src/a.ts", line: 9999, body: "bad line" }],
      }),
      /GitHub API 422/,
    );
    // Only ONE HTTP call — the retry at the HTTP layer never fires for 422.
    assert.equal(stub.calls.length, 1);
  });
});

test("GitHubClient gives up on a 404 without retrying", async () => {
  const stub = new FetchStub([
    { kind: "error", status: 404, body: "not found" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await assert.rejects(
      client.listOpenPullRequests("owner/repo"),
      /GitHub API 404/,
    );
    // A 404 is deterministic — retrying won't help.
    assert.equal(stub.calls.length, 1);
  });
});

test("GitHubClient dismissReview uses the dismissals endpoint", async () => {
  const stub = new FetchStub([
    { kind: "ok", status: 200, body: "{}" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await client.dismissReview("owner/repo", 7, 42, "superseded by newer head");
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]?.method, "PUT");
    assert.match(stub.calls[0]?.url ?? "", /\/repos\/owner\/repo\/pulls\/7\/reviews\/42\/dismissals$/);
  });
});

test("GitHubClient normalizes merged pull requests to MERGED state", async () => {
  const stub = new FetchStub([
    {
      kind: "ok",
      status: 200,
      body: JSON.stringify({
        number: 16,
        title: "Fix 502 error during conversation",
        html_url: "https://github.com/owner/repo/pull/16",
        state: "closed",
        draft: false,
        merged_at: "2026-04-12T12:46:04Z",
        closed_at: "2026-04-12T12:46:04Z",
        head: { sha: "abc123", ref: "feature" },
        base: { ref: "main" },
      }),
    },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    const pr = await client.getPullRequest("owner/repo", 16);
    assert.equal(pr.state, "MERGED");
    assert.equal(pr.mergedAt, "2026-04-12T12:46:04Z");
  });
});

// ---- parseModelResponse tests ----------------------------------------

test("parseModelResponse returns ok for a valid JSON response", () => {
  const message = `Here is the review:
{
  "walkthrough": "This PR changes the admission flow. Looks fine.",
  "architectural_concerns": [],
  "findings": [],
  "verdict": "approve",
  "verdict_reason": "No issues found."
}`;
  const result = parseModelResponse(message);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verdict.verdict, "approve");
    assert.equal(result.verdict.walkthrough, "This PR changes the admission flow. Looks fine.");
  }
});

test("parseModelResponse returns a reason when the message has no JSON object", () => {
  const result = parseModelResponse("I'm sorry, I cannot review this PR.");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /no JSON object found/);
  }
});

test("parseModelResponse returns a reason when JSON is unrecoverably malformed", () => {
  // Missing closing brace — forgivingJsonParse can't fix this.
  const result = parseModelResponse("{\"walkthrough\": \"x\", \"findings\": [  ");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /no JSON object found/);
    // (the brace-walker fails to find a balanced block, so this falls
    // into the first branch rather than the parser-failed branch)
  }
});

test("parseModelResponse returns a reason when JSON parses but schema normalization fails", () => {
  // Valid JSON but no recognizable verdict field. normalizeVerdict throws
  // and parseModelResponse converts that to a reason. (Empty walkthrough
  // is now legitimate under the inverted-pyramid body layout, so we use a
  // missing-verdict payload to exercise the schema-failure path instead.)
  const result = parseModelResponse("{\"findings\":[],\"walkthrough\":\"x\"}");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /schema/);
  }
});

test("parseModelResponse recovers from a markdown-fenced response", () => {
  const message = "Here's the review:\n```json\n{\"walkthrough\":\"x\",\"findings\":[],\"verdict\":\"approve\",\"verdict_reason\":\"y\"}\n```";
  const result = parseModelResponse(message);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.verdict.walkthrough, "x");
  }
});
