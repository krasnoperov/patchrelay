import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadEvalCase, loadEvalCases } from "../src/eval/case-file.ts";

test("loadEvalCase reads plain Markdown metadata and marker lists", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "review-quill-eval-case-"));
  try {
    writeFileSync(path.join(directory, "body.md"), "PR body\n\n## Safe nested heading\n", "utf8");
    writeFileSync(path.join(directory, "sample.case.md"), `# sample-case

Repository: acme/demo
Pull request: 12
Base SHA: 1111111111111111111111111111111111111111
Head SHA: 2222222222222222222222222222222222222222
Base branch: main
Head branch: feature/demo
Title: fix: demo
Body file: body.md
Expected verdict: request_changes
Maximum concerns: 1
Nits: forbid

## Review docs
- REVIEW_WORKFLOW.md

## Must report
- reachable input; data loss

## Must not report
- rare race; theoretical
`, "utf8");

    const parsed = await loadEvalCase(path.join(directory, "sample.case.md"));
    assert.equal(parsed.id, "sample-case");
    assert.equal(parsed.body, "PR body\n\n## Safe nested heading");
    assert.deepEqual(parsed.reviewDocs, ["REVIEW_WORKFLOW.md"]);
    assert.deepEqual(parsed.mustReport, [["reachable input", "data loss"]]);
    assert.deepEqual(parsed.mustNotReport, [["rare race", "theoretical"]]);
    assert.equal(parsed.forbidNits, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the bundled starter suite is a rejected/fixed pair", async () => {
  const cases = await loadEvalCases(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../eval/cases"));
  assert.deepEqual(cases.map((entry) => entry.id), ["usertold-1252-rejected-head", "usertold-1252-fixed-head"]);
  assert.deepEqual(cases.map((entry) => entry.expectedVerdict), ["request_changes", "approve"]);
  assert.deepEqual(cases.map((entry) => entry.maximumConcerns), [1, 0]);
});
