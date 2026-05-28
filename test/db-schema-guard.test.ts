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
    db.connection.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
});

