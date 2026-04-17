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
      repositories: [
        {
          repoId: "mafia",
          repoFullName: "owner/repo",
        },
      ],
    }, null, 2));

    const config = loadConfig(configPath);
    assert.equal(config.repositories[0]?.waitForGreenChecks, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
