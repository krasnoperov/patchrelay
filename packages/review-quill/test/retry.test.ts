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

test("GitHubClient retries a GET up to 3 attempts and throws the last error", async () => {
  const stub = new FetchStub([
    { kind: "error", status: 500, body: "first" },
    { kind: "error", status: 502, body: "second" },
    { kind: "error", status: 503, body: "third" },
  ]);
  await withFetchStub(stub, async () => {
    const client = makeClient();
    await assert.rejects(
      client.listOpenPullRequests("owner/repo"),
      /GitHub API 503.*third/,
    );
    assert.equal(stub.calls.length, 3);
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
  // Valid JSON but no walkthrough / no summary / no overview / no description.
  // normalizeVerdict will throw and parseModelResponse converts that to a reason.
  const result = parseModelResponse("{\"findings\":[],\"verdict\":\"approve\"}");
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
