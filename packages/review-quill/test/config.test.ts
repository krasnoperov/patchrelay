import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.ts";

test("loadConfig resolves installation prompt files relative to the config file", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-config-prompting-"));
  const configDir = path.join(baseDir, "config");
  const configPath = path.join(configDir, "review-quill.json");

  try {
    mkdirSync(path.join(configDir, "prompts"), { recursive: true });
    writeFileSync(path.join(configDir, "prompts", "review-policy.md"), "Install review policy\n");
    writeFileSync(path.join(configDir, "prompts", "review-rubric.md"), "## Review rules\n\nCustom review policy\n");
    writeFileSync(configPath, JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: path.join(baseDir, "review-quill.sqlite"), wal: true },
      prompting: {
        extra_instructions_file: "./prompts/review-policy.md",
        replace_sections: {
          "review-rubric": "./prompts/review-rubric.md",
        },
      },
      repositories: [],
    }, null, 2));

    const config = loadConfig(configPath);
    assert.equal(config.prompting.extraInstructions?.content, "Install review policy");
    assert.equal(config.prompting.replaceSections["review-rubric"]?.content, "## Review rules\n\nCustom review policy");
    assert.equal(config.codex.model, "gpt-5.5");
    assert.equal(config.codex.outputSchema, true);
    assert.equal(config.codex.forkPriorReviewThread, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig defaults waitForGreenChecks to false for repositories", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-config-repo-defaults-"));
  const configDir = path.join(baseDir, "config");
  const configPath = path.join(configDir, "review-quill.json");

  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: path.join(baseDir, "review-quill.sqlite"), wal: true },
      codex: { outputSchema: false, forkPriorReviewThread: true },
      repositories: [
        {
          repoId: "mafia",
          repoFullName: "owner/repo",
        },
      ],
    }, null, 2));

    const config = loadConfig(configPath);
    assert.equal(config.repositories[0]?.waitForGreenChecks, false);
    assert.deepEqual(config.repositories[0]?.reviewDocs, ["REVIEW_WORKFLOW.md", "AGENTS.md"]);
    assert.equal(config.codex.model, "gpt-5.5");
    assert.equal(config.codex.outputSchema, false);
    assert.equal(config.codex.forkPriorReviewThread, true);
    assert.equal(config.reconciliation.headStabilizationMs, 20_000);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig preserves review surface mode and no-cache label repository options", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-config-review-surface-"));
  const configDir = path.join(baseDir, "config");
  const configPath = path.join(configDir, "review-quill.json");

  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      server: { bind: "127.0.0.1", port: 8788 },
      database: { path: path.join(baseDir, "review-quill.sqlite"), wal: true },
      repositories: [
        {
          repoId: "usertold",
          repoFullName: "owner/repo",
          reviewSurfaceMode: "integration_tree",
          noCacheLabel: "review:fresh",
        },
      ],
    }, null, 2));

    const config = loadConfig(configPath);
    assert.equal(config.repositories[0]?.reviewSurfaceMode, "integration_tree");
    assert.equal(config.repositories[0]?.noCacheLabel, "review:fresh");
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loadConfig preserves maxConcurrentReviews reconciliation override", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "review-quill-config-concurrency-"));
  const configDir = path.join(baseDir, "config");
  const configPath = path.join(configDir, "review-quill.json");

  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      database: { path: path.join(baseDir, "review-quill.sqlite"), wal: true },
      reconciliation: {
        pollIntervalMs: 120_000,
        headStabilizationMs: 7_500,
        maxConcurrentReviews: 3,
      },
    }, null, 2));

    const config = loadConfig(configPath);
    assert.equal(config.reconciliation.maxConcurrentReviews, 3);
    assert.equal(config.reconciliation.headStabilizationMs, 7_500);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
