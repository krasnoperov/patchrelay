import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInsertBindings,
  buildUpdateAssignments,
  ISSUE_COLUMN_DEFS,
  ISSUE_COLUMN_KEYS,
} from "../src/db/issue-upsert-columns.ts";

test("buildUpdateAssignments emits no assignments when only id fields are supplied", () => {
  const { assignments, values } = buildUpdateAssignments({
    projectId: "p",
    linearIssueId: "i",
  });
  assert.deepEqual(assignments, []);
  assert.deepEqual(values, {});
});

test("buildUpdateAssignments uses COALESCE for fields marked as discover-once", () => {
  const { assignments } = buildUpdateAssignments({
    projectId: "p",
    linearIssueId: "i",
    issueKey: "ABC-1",
    title: "Hello",
  });
  assert.ok(assignments.includes("issue_key = COALESCE(@issueKey, issue_key)"));
  assert.ok(assignments.includes("title = COALESCE(@title, title)"));
});

test("buildUpdateAssignments uses plain assignment for non-COALESCE fields", () => {
  const { assignments } = buildUpdateAssignments({
    projectId: "p",
    linearIssueId: "i",
    factoryState: "delegated",
  });
  assert.ok(assignments.includes("factory_state = @factoryState"));
  assert.equal(assignments.some((assignment) => assignment.includes("pending_run")), false);
});

test("buildUpdateAssignments runs transforms (booleans → 0/1)", () => {
  const { values } = buildUpdateAssignments({
    projectId: "p",
    linearIssueId: "i",
    delegatedToPatchRelay: true,
    prIsDraft: false,
  });
  assert.equal(values.delegatedToPatchRelay, 1);
  assert.equal(values.prIsDraft, 0);
});

test("buildUpdateAssignments preserves null for nullable booleans like prIsDraft", () => {
  const { values } = buildUpdateAssignments({
    projectId: "p",
    linearIssueId: "i",
    prIsDraft: null,
  });
  assert.equal(values.prIsDraft, null);
});

test("buildInsertBindings emits one column + placeholder per defined field", () => {
  const { columns, placeholders, values } = buildInsertBindings({
    projectId: "p",
    linearIssueId: "i",
  });
  assert.equal(columns.length, ISSUE_COLUMN_KEYS.length);
  assert.equal(placeholders.length, ISSUE_COLUMN_KEYS.length);
  // Every key bound, even when value is null/default.
  for (const key of ISSUE_COLUMN_KEYS) {
    assert.ok(key in values, `expected binding for ${key}`);
  }
});

test("buildInsertBindings honors insertDefaults", () => {
  const { values } = buildInsertBindings({
    projectId: "p",
    linearIssueId: "i",
  });
  // delegated_to_patchrelay defaults to 1
  assert.equal(values.delegatedToPatchRelay, 1);
  // factory_state defaults to "delegated"
  assert.equal(values.factoryState, "delegated");
  // ci_repair_attempts defaults to 0
  assert.equal(values.ciRepairAttempts, 0);
});

test("buildInsertBindings explicit false overrides delegatedToPatchRelay default", () => {
  const { values } = buildInsertBindings({
    projectId: "p",
    linearIssueId: "i",
    delegatedToPatchRelay: false,
  });
  assert.equal(values.delegatedToPatchRelay, 0);
});

test("buildInsertBindings stores nulls for unspecified nullable columns", () => {
  const { values } = buildInsertBindings({
    projectId: "p",
    linearIssueId: "i",
  });
  assert.equal(values.prNumber, null);
  assert.equal(values.lastGitHubFailureSignature, null);
});

test("ISSUE_COLUMN_DEFS column names are unique and snake_case", () => {
  const seen = new Set<string>();
  for (const key of ISSUE_COLUMN_KEYS) {
    const def = ISSUE_COLUMN_DEFS[key];
    assert.ok(!seen.has(def.column), `duplicate column: ${def.column}`);
    seen.add(def.column);
    assert.match(def.column, /^[a-z_]+$/, `column ${def.column} not snake_case`);
  }
});
