import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";

test("PatchRelayDatabase reports wrong or uninitialized database paths clearly", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-guard-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "empty.sqlite"), true);
  try {
    assert.throws(
      () => db.assertSchemaReady(),
      /PatchRelay database is uninitialized or points at the wrong path: .*empty\.sqlite.*issues/,
    );
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelayDatabase rejects a database missing a final-schema column", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-column-guard-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "incomplete.sqlite"), true);
  try {
    db.initializeSchema();
    db.unsafeRawConnectionForTests().exec("ALTER TABLE operator_feed_events DROP COLUMN workflow_id");
    assert.throws(
      () => db.initializeSchema(),
      /Missing required column\(s\): operator_feed_events\.workflow_id/,
    );
    const columns = db.unsafeRawConnectionForTests().prepare("PRAGMA table_info(operator_feed_events)").all();
    assert.equal(columns.some((column) => column.name === "workflow_id"), false);
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelayDatabase rejects a database missing a final-schema index", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-index-guard-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "incomplete.sqlite"), true);
  try {
    db.initializeSchema();
    db.unsafeRawConnectionForTests().exec("DROP INDEX idx_issues_pr_number");
    assert.throws(
      () => db.initializeSchema(),
      /Missing required index\(es\): idx_issues_pr_number/,
    );
    const index = db.unsafeRawConnectionForTests()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_issues_pr_number'")
      .get();
    assert.equal(index, undefined);
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelayDatabase rejects obsolete schema columns", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-obsolete-column-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "obsolete.sqlite"), true);
  try {
    db.initializeSchema();
    db.unsafeRawConnectionForTests().exec("ALTER TABLE issues ADD COLUMN legacy_stage TEXT");
    assert.throws(
      () => db.initializeSchema(),
      /Obsolete column\(s\): issues\.legacy_stage/,
    );
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("PatchRelayDatabase rejects an existing database missing a final-schema table", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-schema-table-guard-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "incomplete.sqlite"), true);
  try {
    db.initializeSchema();
    db.unsafeRawConnectionForTests().exec("DROP TABLE workflow_tasks");
    assert.throws(
      () => db.initializeSchema(),
      /Missing required table\(s\): workflow_tasks/,
    );
    const table = db.unsafeRawConnectionForTests()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_tasks'")
      .get();
    assert.equal(table, undefined);
  } finally {
    db.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});
