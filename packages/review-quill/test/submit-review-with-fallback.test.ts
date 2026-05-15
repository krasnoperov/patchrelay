import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import type { GitHubClient } from "../src/github-client.ts";
import { submitReviewWithFallback } from "../src/submit-review-with-fallback.ts";

function silentLogger() {
  return pino({ level: "silent" });
}

function makeGithubStub(): {
  github: Pick<GitHubClient, "submitReview">;
  calls: Array<Parameters<GitHubClient["submitReview"]>>;
  setNextError: (error: Error) => void;
} {
  const calls: Array<Parameters<GitHubClient["submitReview"]>> = [];
  let nextError: Error | undefined;
  return {
    github: {
      submitReview: (async (...args: Parameters<GitHubClient["submitReview"]>) => {
        calls.push(args);
        if (nextError) {
          const toThrow = nextError;
          nextError = undefined;
          throw toThrow;
        }
        return undefined as never;
      }) as GitHubClient["submitReview"],
    },
    calls,
    setNextError: (error: Error) => { nextError = error; },
  };
}

test("submitReviewWithFallback posts the primary body when GitHub accepts it", async () => {
  const stub = makeGithubStub();
  const result = await submitReviewWithFallback({
    github: stub.github as GitHubClient,
    logger: silentLogger(),
    repoFullName: "owner/repo",
    prNumber: 1,
    headSha: "abc",
    event: "APPROVE",
    primaryBody: "primary",
    inlineComments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "comment" }],
    buildFallbackBody: () => "fallback",
  });
  assert.equal(result, "primary");
  assert.equal(stub.calls.length, 1);
  const submitted = stub.calls[0]?.[2] as { body: string; comments?: unknown[] };
  assert.equal(submitted.body, "primary");
  assert.equal(submitted.comments?.length, 1);
});

test("submitReviewWithFallback rethrows non-422 errors without retrying", async () => {
  const stub = makeGithubStub();
  stub.setNextError(new Error("GitHub API 500: server is sad"));
  await assert.rejects(
    submitReviewWithFallback({
      github: stub.github as GitHubClient,
      logger: silentLogger(),
      repoFullName: "owner/repo",
      prNumber: 1,
      headSha: "abc",
      event: "APPROVE",
      primaryBody: "primary",
      inlineComments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "c" }],
      buildFallbackBody: () => "fallback",
    }),
    /500/,
  );
  assert.equal(stub.calls.length, 1, "no retry on non-422");
});

test("submitReviewWithFallback rethrows 422 when there are no inline comments to drop", async () => {
  const stub = makeGithubStub();
  stub.setNextError(new Error("GitHub API 422 Unprocessable Entity"));
  await assert.rejects(
    submitReviewWithFallback({
      github: stub.github as GitHubClient,
      logger: silentLogger(),
      repoFullName: "owner/repo",
      prNumber: 1,
      headSha: "abc",
      event: "APPROVE",
      primaryBody: "primary",
      inlineComments: [],
      buildFallbackBody: () => "fallback",
    }),
    /422/,
  );
  assert.equal(stub.calls.length, 1, "no retry when nothing to drop");
});

test("submitReviewWithFallback retries body-only on 422 with inline comments and returns the fallback body", async () => {
  const stub = makeGithubStub();
  stub.setNextError(new Error("GitHub API 422 Unprocessable Entity: inline path not in diff"));
  const result = await submitReviewWithFallback({
    github: stub.github as GitHubClient,
    logger: silentLogger(),
    repoFullName: "owner/repo",
    prNumber: 1,
    headSha: "abc",
    event: "REQUEST_CHANGES",
    primaryBody: "primary",
    inlineComments: [{ path: "src/a.ts", line: 1, side: "RIGHT", body: "c" }],
    buildFallbackBody: () => "fallback-with-findings",
  });
  assert.equal(result, "fallback-with-findings");
  assert.equal(stub.calls.length, 2);
  const second = stub.calls[1]?.[2] as { body: string; comments?: unknown[] };
  assert.equal(second.body, "fallback-with-findings");
  assert.equal(second.comments, undefined);
});
