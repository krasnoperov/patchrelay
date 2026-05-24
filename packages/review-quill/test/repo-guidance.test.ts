import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("loadRepoGuidanceDocs includes local markdown docs explicitly referenced by PR text", async () => {
  const repoPath = mkdtempSync(path.join(tmpdir(), "review-quill-guidance-pr-text-"));
  try {
    writeFileSync(path.join(repoPath, "AGENTS.md"), "Universal guidance\n");
    writeFileSync(path.join(repoPath, "REVIEW_WORKFLOW.md"), "Review guidance\n");
    mkdirSync(path.join(repoPath, "docs"));
    writeFileSync(path.join(repoPath, "docs", "translation.md"), "Translation rubric\n");
    writeFileSync(path.join(repoPath, "docs", "ignored.md"), "Not referenced\n");

    const docs = await loadRepoGuidanceDocs(
      repoPath,
      ["REVIEW_WORKFLOW.md"],
      ["Audit against [docs/translation.md](docs/translation.md) and keep timing intact."],
    );

    assert.deepEqual(docs.map((doc) => doc.path), ["REVIEW_WORKFLOW.md", "AGENTS.md", "docs/translation.md"]);
    assert.deepEqual(docs.map((doc) => doc.text), ["Review guidance\n", "Universal guidance\n", "Translation rubric\n"]);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
