import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { OperatorEventFeed } from "../src/operator-feed.ts";

test("operator feed persists events and supports issue/project filters across feed instances", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-operator-feed-store-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    const firstFeed = new OperatorEventFeed(db.operatorFeed);
    firstFeed.publish({
      level: "info",
      kind: "stage",
      issueKey: "USE-25",
      projectId: "usertold",
      stage: "review",
      status: "running",
      summary: "Started review workflow",
    });
    firstFeed.publish({
      level: "warn",
      kind: "comment",
      issueKey: "OPS-9",
      projectId: "ops",
      status: "delivery_failed",
      summary: "Could not deliver follow-up comment",
    });

    const secondFeed = new OperatorEventFeed(db.operatorFeed);
    const issueEvents = secondFeed.list({ issueKey: "USE-25" });
    assert.equal(issueEvents.length, 1);
    assert.equal(issueEvents[0]?.summary, "Started review workflow");

    const projectEvents = secondFeed.list({ projectId: "ops" });
    assert.equal(projectEvents.length, 1);
    assert.equal(projectEvents[0]?.status, "delivery_failed");

    const allEvents = secondFeed.list({ limit: 10 });
    assert.equal(allEvents.length, 2);
    assert.ok((allEvents[0]?.id ?? 0) > 0);
    assert.ok((allEvents[1]?.id ?? 0) > (allEvents[0]?.id ?? 0));
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
