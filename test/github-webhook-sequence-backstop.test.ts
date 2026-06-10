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

function filesResponse(filenames: string[]): Response {
  return new Response(JSON.stringify(filenames.map((filename) => ({ filename }))), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("sequence backstop dedupes the overlap alert per PR pair and caches file sets per head", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-sequence-backstop-"));
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "issue-candidate",
      issueKey: "USE-1",
      factoryState: "pr_open",
      branchName: "use/candidate",
      prNumber: 200,
      prHeadSha: "candidate-head",
    });

    const fetchedUrls: string[] = [];
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input);
      fetchedUrls.push(url);
      return Promise.resolve(filesResponse(url.includes("/pulls/100/") ? ["src/a.ts", "src/b.ts"] : ["src/b.ts"]));
    };

    const event: NormalizedGitHubEvent = {
      triggerEvent: "pr_opened",
      repoFullName: "owner/repo",
      branchName: "use/new",
      headSha: "new-head",
      prNumber: 100,
    };

    const caches = createSequenceBackstopCaches();
    const feed = new OperatorEventFeed();
    const logger = pino({ enabled: false });

    await maybeRunSequenceBackstop({ db, logger, feed, event, fetchImpl, caches });
    assert.equal(feed.list().length, 1);
    assert.equal(fetchedUrls.length, 2);
    assert.ok(caches.changedFilesByHead.has("owner/repo@new-head"));
    assert.ok(caches.changedFilesByHead.has("owner/repo@candidate-head"));
    assert.ok(caches.alertedPrPairs.has("owner/repo#100->#200"));

    // A redelivery of the same pr_opened neither refetches (file sets are
    // cached per head) nor re-alerts (the pair already fired).
    await maybeRunSequenceBackstop({ db, logger, feed, event, fetchImpl, caches });
    assert.equal(feed.list().length, 1);
    assert.equal(fetchedUrls.length, 2);

    db.close();
  } finally {
    if (previousToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousToken;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("sequence backstop stays quiet without overlapping files", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-sequence-backstop-quiet-"));
  const previousToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "test-token";
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();
    db.upsertIssue({
      projectId: "owner/repo",
      linearIssueId: "issue-candidate",
      issueKey: "USE-2",
      factoryState: "pr_open",
      branchName: "use/candidate",
      prNumber: 200,
      prHeadSha: "candidate-head",
    });

    const fetchImpl: typeof fetch = (input) =>
      Promise.resolve(filesResponse(String(input).includes("/pulls/100/") ? ["src/a.ts"] : ["src/z.ts"]));

    const caches = createSequenceBackstopCaches();
    const feed = new OperatorEventFeed();

    await maybeRunSequenceBackstop({
      db,
      logger: pino({ enabled: false }),
      feed,
      event: {
        triggerEvent: "pr_opened",
        repoFullName: "owner/repo",
        branchName: "use/new",
        headSha: "new-head",
        prNumber: 100,
      },
      fetchImpl,
      caches,
    });
    assert.equal(feed.list().length, 0);
    assert.equal(caches.alertedPrPairs.size, 0);

    db.close();
  } finally {
    if (previousToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = previousToken;
    }
    rmSync(baseDir, { recursive: true, force: true });
  }
});
