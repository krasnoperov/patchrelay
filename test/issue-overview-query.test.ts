import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { IssueOverviewQuery } from "../src/issue-overview-query.ts";

test("issue overview derives waiting reason without a stored session lifecycle", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-issue-overview-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.runMigrations();

    db.upsertIssue({
      projectId: "usertold",
      linearIssueId: "issue-1",
      issueKey: "USE-1",
      title: "Tune chat UI",
      delegatedToPatchRelay: true,
      workflowOutcome: undefined,
      prNumber: 22,
      prState: "open",
      prHeadSha: "sha-new",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      lastBlockingReviewHeadSha: "sha-old",
    });

    const sessionColumns = db.unsafeRawConnectionForTests()
      .prepare("PRAGMA table_info(issue_sessions)")
      .all() as Array<Record<string, unknown>>;
    assert.equal(sessionColumns.some((column) => column.name === "waiting_reason"), false);
    assert.equal(sessionColumns.some((column) => column.name === "session_state"), false);

    const query = new IssueOverviewQuery(
      db,
      { readThread: async () => ({ id: "thread-1", turns: [] }) } as never,
      { getActiveRunStatus: async () => undefined },
    );

    const overview = await query.getIssueOverview("USE-1");
    assert.equal(overview?.issue.waitingReason, "Waiting on review of a newer pushed head");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
