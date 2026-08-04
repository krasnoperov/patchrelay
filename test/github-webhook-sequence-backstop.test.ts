import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import {
  createSequenceBackstopCaches,
  maybeRunSequenceBackstop,
} from "../src/github-webhook-sequence-backstop.ts";
import type { NormalizedGitHubEvent } from "../src/github-types.ts";
import { OperatorEventFeed } from "../src/operator-feed.ts";

function compareResponse(status: "ahead" | "diverged" | "identical", mergeBase?: string): Response {
  return new Response(JSON.stringify({
    status,
    ...(mergeBase ? { merge_base_commit: { sha: mergeBase } } : {}),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function withCandidate(db: PatchRelayDatabase): void {
  db.upsertIssue({
    projectId: "owner/repo",
    linearIssueId: "issue-candidate",
    issueKey: "USE-1",
    workflowOutcome: undefined,
    branchName: "use/candidate",
    prState: "open",
    prNumber: 200,
    prHeadSha: "candidate-head",
  });
}

const openedEvent: NormalizedGitHubEvent = {
  triggerEvent: "pr_opened",
  repoFullName: "owner/repo",
  branchName: "use/new",
  headSha: "new-head",
  prNumber: 100,
  prBaseRef: "main",
};

test("sequence backstop alerts only on shared unlanded history within the same repository", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-sequence-backstop-"));
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();
    withCandidate(db);
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "issue-opened",
      issueKey: "USE-NEW",
      workflowOutcome: undefined,
      branchName: "use/new",
      prState: "open",
      prNumber: 100,
      prHeadSha: "new-head",
    });
    db.upsertIssue({
      projectId: "other/repo",
      linearIssueId: "foreign-opened",
      issueKey: "OTHER-100",
      workflowOutcome: undefined,
      branchName: "other/new",
      prState: "open",
      prNumber: 100,
      prHeadSha: "foreign-new-head",
    });
    db.upsertIssue({
      projectId: "other/repo",
      linearIssueId: "foreign-candidate",
      issueKey: "OTHER-300",
      workflowOutcome: undefined,
      branchName: "other/candidate",
      prState: "open",
      prNumber: 300,
      prHeadSha: "foreign-candidate-head",
    });

    const fetchedUrls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      fetchedUrls.push(String(input));
      return Promise.resolve(
        fetchedUrls.length === 1
          ? compareResponse("diverged", "shared-unlanded")
          : compareResponse("diverged"),
      );
    };
    const caches = createSequenceBackstopCaches();
    const feed = new OperatorEventFeed();

    await maybeRunSequenceBackstop({
      db,
      logger: pino({ enabled: false }),
      feed,
      event: openedEvent,
      fetchImpl,
      caches,
    });

    assert.equal(feed.list().length, 1);
    assert.match(feed.list()[0]!.summary, /shares unlanded history with open PR #200/);
    assert.equal(feed.list()[0]!.issueKey, "USE-NEW");
    assert.equal(fetchedUrls.length, 2);
    assert.match(fetchedUrls[0]!, /compare\/candidate-head\.\.\.new-head/);
    assert.match(fetchedUrls[1]!, /compare\/shared-unlanded\.\.\.main/);
    assert.equal(caches.ancestryByHeadPair.get("owner/repo@candidate-head...new-head@main"), true);

    await maybeRunSequenceBackstop({
      db,
      logger: pino({ enabled: false }),
      feed,
      event: openedEvent,
      fetchImpl,
      caches,
    });
    assert.equal(feed.list().length, 1);
    assert.equal(fetchedUrls.length, 2);

    db.close();
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("sequence backstop ignores overlapping but independent PR histories", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-sequence-backstop-quiet-"));
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();
    withCandidate(db);
    const feed = new OperatorEventFeed();

    await maybeRunSequenceBackstop({
      db,
      logger: pino({ enabled: false }),
      feed,
      event: openedEvent,
      fetchImpl: (input) => Promise.resolve(
        String(input).includes("candidate-head...new-head")
          ? compareResponse("diverged", "shared-main")
          : compareResponse("ahead"),
      ),
      caches: createSequenceBackstopCaches(),
    });

    assert.equal(feed.list().length, 0);
    db.close();
  } finally {
    if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousToken;
    rmSync(baseDir, { recursive: true, force: true });
  }
});
