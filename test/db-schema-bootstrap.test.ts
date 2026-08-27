import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";

test("database bootstrap creates the complete final schema", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-bootstrap-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.initializeSchema();
    const connection = db.unsafeRawConnectionForTests();

    const issueColumns = new Set(
      connection.prepare("PRAGMA table_info(issues)").all().map((column) => String(column.name)),
    );
    for (const column of [
      "description",
      "last_github_failure_context_json",
      "last_published_patch_id",
      "deploy_started_at",
      "version",
      "capacity_backoff_until",
      "capacity_backoff_attempts",
    ]) {
      assert.equal(issueColumns.has(column), true, `missing issues.${column}`);
    }

    const runColumns = new Set(
      connection.prepare("PRAGMA table_info(runs)").all().map((column) => String(column.name)),
    );
    for (const column of ["authority_epoch", "lease_revoked_at", "lease_revoke_reason", "task_id"]) {
      assert.equal(runColumns.has(column), true, `missing runs.${column}`);
    }

    const indexes = new Set(
      connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((index) => String(index.name)),
    );
    for (const index of ["idx_issues_pr_number", "idx_issues_parent_pr_branch", "idx_issues_workflow_outcome"]) {
      assert.equal(indexes.has(index), true, `missing index ${index}`);
    }

    db.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("database bootstrap is idempotent and preserves existing rows", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-idempotent-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
    db.initializeSchema();
    const connection = db.unsafeRawConnectionForTests();
    connection.prepare(`
      INSERT INTO issues (project_id, linear_issue_id, issue_key, title, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("krasnoperov/patchrelay", "issue-1", "PAT-1", "Keep this row", "2026-08-04T00:00:00.000Z");

    db.initializeSchema();

    const row = connection
      .prepare("SELECT issue_key, title FROM issues WHERE project_id = ? AND linear_issue_id = ?")
      .get("krasnoperov/patchrelay", "issue-1");
    assert.equal(row?.issue_key, "PAT-1");
    assert.equal(row?.title, "Keep this row");
    db.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("database bootstrap contains no data migration or destructive DDL", () => {
  const source = readFileSync(new URL("../src/db/schema.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i);
  assert.doesNotMatch(source, /issues_new/i);
});
