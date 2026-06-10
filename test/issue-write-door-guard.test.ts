import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

// Architecture guardrail (core simplification plan, phase A): every
// production issue-state write must go through
// `IssueSessionStore.commitIssueState` — the single door that wraps lease
// validity, the optimistic version check, and conflict telemetry. Raw
// `.upsertIssue(` calls outside the allowlist below bypass all three.
//
// If this test fails on a file you just edited, use
// `db.issueSessions.commitIssueState({ writer, update, ... })` instead of
// `db.issues.upsertIssue(...)` / `db.upsertIssue(...)`.
const ALLOWED_RAW_UPSERT_FILES = new Set([
  // The write primitive itself and the door that wraps it.
  "src/db/issue-store.ts",
  "src/db/issue-session-store.ts",
  // Facade delegation only (used by tests and the operator CLI).
  "src/db.ts",
  // Operator CLI manual repair actions — interactive, single-writer by
  // construction. Fold into the door when the CLI layer is reworked.
  "src/cli/data.ts",
]);

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

test("issue-state writes outside the allowlist go through commitIssueState", () => {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const srcDir = path.join(repoRoot, "src");
  const offenders: string[] = [];

  for (const file of listSourceFiles(srcDir)) {
    const relative = path.relative(repoRoot, file);
    if (ALLOWED_RAW_UPSERT_FILES.has(relative)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    lines.forEach((line, index) => {
      if (/\.upsertIssue\(/.test(line)) {
        offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Raw upsertIssue calls bypass the versioned write door (use db.issueSessions.commitIssueState):\n${offenders.join("\n")}`,
  );
});
