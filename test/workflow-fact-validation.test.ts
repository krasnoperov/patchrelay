import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";
import { SqliteConnection } from "../src/db/shared.ts";

test("issue reads reject invalid persisted workflow facts", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-workflow-facts-"));
  try {
    const dbPath = path.join(baseDir, "patchrelay.sqlite");
    const db = new PatchRelayDatabase(dbPath, true);
    db.runMigrations();
    db.upsertIssue({ projectId: "project", linearIssueId: "issue", workflowOutcome: undefined });
    const raw = new SqliteConnection(dbPath);

    raw.prepare("UPDATE issues SET workflow_outcome = 'delegated' WHERE project_id = 'project'").run();
    assert.throws(() => db.getIssue("project", "issue"), /Invalid persisted workflow_outcome: delegated/);

    raw.prepare("UPDATE issues SET workflow_outcome = NULL, input_request_kind = 'waiting' WHERE project_id = 'project'").run();
    assert.throws(() => db.getIssue("project", "issue"), /Invalid persisted input_request_kind: waiting/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
