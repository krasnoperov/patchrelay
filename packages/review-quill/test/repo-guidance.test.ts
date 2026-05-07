import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRepoGuidanceDocs } from "../src/prompt-context/repo-guidance.ts";

test("loadRepoGuidanceDocs loads configured docs plus universal AGENTS.md in order", async () => {
  const repoPath = mkdtempSync(path.join(tmpdir(), "review-quill-guidance-"));
  try {
    writeFileSync(path.join(repoPath, "AGENTS.md"), "Universal guidance\n");
    writeFileSync(path.join(repoPath, "REVIEW_WORKFLOW.md"), "Review guidance\n");
    writeFileSync(path.join(repoPath, "CLAUDE.md"), "Interactive guidance\n");

    const docs = await loadRepoGuidanceDocs(repoPath, ["REVIEW_WORKFLOW.md"]);

    assert.deepEqual(docs.map((doc) => doc.path), ["REVIEW_WORKFLOW.md", "AGENTS.md"]);
    assert.deepEqual(docs.map((doc) => doc.text), ["Review guidance\n", "Universal guidance\n"]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
