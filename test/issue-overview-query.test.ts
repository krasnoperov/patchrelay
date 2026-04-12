import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { IssueOverviewQuery } from "../src/issue-overview-query.ts";

test("issue overview prefers freshly derived waiting reason over stale cached session waiting text", async () => {
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
      factoryState: "pr_open",
      prNumber: 22,
      prState: "open",
      prHeadSha: "sha-new",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
      lastBlockingReviewHeadSha: "sha-old",
    });

    db.connection.prepare(`
      UPDATE issue_sessions
      SET waiting_reason = ?
      WHERE project_id = ? AND linear_issue_id = ?
    `).run(
      "PatchRelay automation is paused because the issue is undelegated",
      "usertold",
      "issue-1",
    );

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
